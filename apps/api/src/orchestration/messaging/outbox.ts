import type { TenantQueryable } from '../../security/tool-approval-store.js';
import type { MessageKind } from './wire.js';

/**
 * P5 outbox operations. Every function here runs inside a transaction supplied by the caller:
 * - `enqueueMessage` is called inside the P4 decision's transaction (see workflow.ts), so the message commits with the decision.
 * - The lifecycle functions (claim, acknowledge, fail, dead-letter, requeue) are each one fenced transaction. They never change content.
 * Time is always the database clock. Leases are fenced by `fencing_token`: a write carrying a stale token changes nothing.
 */

export interface NewOutboundMessage {
  readonly messageId: string;
  readonly tenantId: string;
  readonly executionId: string;
  readonly sender: string;
  readonly destination: string;
  readonly kind: MessageKind;
  readonly envelope: Record<string, unknown>;
  readonly payload: Record<string, unknown>;
  readonly payloadDigest: string;
  readonly maxAttempts: number;
}

export interface ClaimedMessage {
  readonly messageId: string;
  readonly tenantId: string;
  readonly executionId: string;
  readonly kind: MessageKind;
  readonly sender: string;
  readonly destination: string;
  readonly envelope: Record<string, unknown>;
  readonly payload: Record<string, unknown>;
  readonly payloadDigest: string;
  readonly attempts: number;
  readonly maxAttempts: number;
  readonly fencingToken: number;
  /** 'pending' for a first or retried attempt, 'leased' when the previous holder's lease had expired (a recovery). */
  readonly previousStatus: 'pending' | 'leased';
}

export type MessageEventType = 'enqueued' | 'leased' | 'delivered' | 'retry_scheduled' | 'dead_lettered' | 'ack_refused' | 'requeued'
  | 'inbox_processed' | 'inbox_duplicate' | 'inbox_refused' | 'purged';

export async function recordMessageEvent(client: TenantQueryable, input: {
  tenantId: string; executionId: string; messageId: string; eventType: MessageEventType; actorAgent: string | null;
  fencingToken: number | null; reason: string | null;
}): Promise<void> {
  await client.query(
    `INSERT INTO aegis.agent_message_events (tenant_id, execution_id, message_id, event_type, actor_agent, fencing_token, reason)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [input.tenantId, input.executionId, input.messageId, input.eventType, input.actorAgent, input.fencingToken, input.reason]);
}

/** Inserts one outbound message. Called in the same transaction as the decision that produced it. */
export async function enqueueMessage(client: TenantQueryable, message: NewOutboundMessage): Promise<void> {
  await client.query(
    `INSERT INTO aegis.agent_outbox (message_id, tenant_id, execution_id, sender_agent, destination_agent, kind, envelope, payload,
       payload_digest, max_attempts)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9, $10)`,
    [message.messageId, message.tenantId, message.executionId, message.sender, message.destination, message.kind,
      JSON.stringify(message.envelope), JSON.stringify(message.payload), message.payloadDigest, message.maxAttempts]);
  await recordMessageEvent(client, { tenantId: message.tenantId, executionId: message.executionId, messageId: message.messageId,
    eventType: 'enqueued', actorAgent: message.sender, fencingToken: 0, reason: null });
}

/**
 * Marks expired leases whose attempt budget is spent as dead. Returns the rows, so the caller can audit each under its own tenant.
 * Runs under the dispatch scope of the calling agent (it sees only its own sender's messages).
 */
export async function deadLetterExhaustedLeases(client: TenantQueryable, sender: string): Promise<Array<{ message_id: string; tenant_id: string; execution_id: string }>> {
  const result = await client.query<{ message_id: string; tenant_id: string; execution_id: string }>(
    `UPDATE aegis.agent_outbox SET status = 'dead', dead_at = clock_timestamp(), dead_reason = 'retry_exhausted',
         lease_instance = NULL, lease_expires_at = NULL, last_error = 'lease_expired', updated_at = clock_timestamp()
      WHERE sender_agent = $1 AND status = 'leased' AND lease_expires_at <= clock_timestamp() AND attempts >= max_attempts
      RETURNING message_id, tenant_id, execution_id`, [sender]);
  return result.rows;
}

/**
 * Leases up to `limit` due messages for one sender. FOR UPDATE SKIP LOCKED means concurrent dispatchers claim disjoint messages and
 * never wait on one another. A message is due when it is pending and its time has come, or when its lease has expired (recovery).
 */
export async function claimDueMessages(client: TenantQueryable, input: { sender: string; limit: number; instance: string; leaseSeconds: number }):
  Promise<ClaimedMessage[]> {
  const result = await client.query<{
    message_id: string; tenant_id: string; execution_id: string; kind: MessageKind; sender_agent: string; destination_agent: string;
    envelope: Record<string, unknown>; payload: Record<string, unknown>; payload_digest: string; attempts: number; max_attempts: number;
    fencing_token: string; previous_status: 'pending' | 'leased';
  }>(
    `WITH due AS (
       SELECT message_id, status AS previous_status FROM aegis.agent_outbox
        WHERE sender_agent = $1 AND attempts < max_attempts AND (
          (status = 'pending' AND next_attempt_at <= clock_timestamp())
          OR (status = 'leased' AND lease_expires_at <= clock_timestamp()))
        ORDER BY next_attempt_at, message_id
        LIMIT $2
        FOR UPDATE SKIP LOCKED)
     UPDATE aegis.agent_outbox o
        SET status = 'leased', lease_instance = $3, lease_expires_at = clock_timestamp() + make_interval(secs => $4),
            fencing_token = o.fencing_token + 1, attempts = o.attempts + 1, updated_at = clock_timestamp()
       FROM due
      WHERE o.message_id = due.message_id
     RETURNING o.message_id, o.tenant_id, o.execution_id, o.kind, o.sender_agent, o.destination_agent, o.envelope, o.payload,
       o.payload_digest, o.attempts, o.max_attempts, o.fencing_token::text AS fencing_token, due.previous_status`,
    [input.sender, input.limit, input.instance, input.leaseSeconds]);
  return result.rows.map((r) => ({
    messageId: r.message_id, tenantId: r.tenant_id, executionId: r.execution_id, kind: r.kind, sender: r.sender_agent,
    destination: r.destination_agent, envelope: r.envelope, payload: r.payload, payloadDigest: r.payload_digest, attempts: r.attempts,
    maxAttempts: r.max_attempts, fencingToken: Number(r.fencing_token), previousStatus: r.previous_status,
  }));
}

export interface Fence { readonly messageId: string; readonly fencingToken: number }

/** Acknowledges delivery. Accepted only for the current lease holder. A stale holder's acknowledgement changes nothing. */
export async function acknowledgeDelivery(client: TenantQueryable, fence: Fence): Promise<boolean> {
  const result = await client.query(
    `UPDATE aegis.agent_outbox SET status = 'delivered', delivered_at = clock_timestamp(), lease_instance = NULL,
         lease_expires_at = NULL, last_error = NULL, updated_at = clock_timestamp()
      WHERE message_id = $1 AND status = 'leased' AND fencing_token = $2 AND lease_expires_at > clock_timestamp()`,
    [fence.messageId, fence.fencingToken]);
  return (result.rowCount ?? 0) === 1;
}

/** Schedules a retry after `delaySeconds` (computed by the caller, applied by the database clock). Fenced like acknowledgement. */
export async function scheduleRetry(client: TenantQueryable, fence: Fence, input: { delaySeconds: number; reason: string }): Promise<boolean> {
  const result = await client.query(
    `UPDATE aegis.agent_outbox SET status = 'pending', next_attempt_at = clock_timestamp() + make_interval(secs => $3),
         lease_instance = NULL, lease_expires_at = NULL, last_error = $4, updated_at = clock_timestamp()
      WHERE message_id = $1 AND status = 'leased' AND fencing_token = $2 AND lease_expires_at > clock_timestamp()`,
    [fence.messageId, fence.fencingToken, input.delaySeconds, input.reason]);
  return (result.rowCount ?? 0) === 1;
}

/** Moves a leased message to dead letter with a bounded reason. Fenced like acknowledgement. The row is kept; nothing is dropped. */
export async function deadLetter(client: TenantQueryable, fence: Fence, reason: { deadReason: string; lastError: string }): Promise<boolean> {
  const result = await client.query(
    `UPDATE aegis.agent_outbox SET status = 'dead', dead_at = clock_timestamp(), dead_reason = $3, last_error = $4,
         lease_instance = NULL, lease_expires_at = NULL, updated_at = clock_timestamp()
      WHERE message_id = $1 AND status = 'leased' AND fencing_token = $2 AND lease_expires_at > clock_timestamp()`,
    [fence.messageId, fence.fencingToken, reason.deadReason, reason.lastError]);
  return (result.rowCount ?? 0) === 1;
}

/**
 * Operator requeue of a dead message, with a new attempt budget of `budget` attempts beyond those already made. Explicit and audited:
 * the action row records a digest of the operator and a bounded reason. Runs under tenant scope, so an operator can only requeue
 * messages of the tenant they name.
 */
export async function requeueDeadMessage(client: TenantQueryable, input: {
  tenantId: string; messageId: string; operatorRef: string; reason: string; budget: number;
}): Promise<boolean> {
  const current = await client.query<{ execution_id: string; attempts: number }>(
    `SELECT execution_id, attempts FROM aegis.agent_outbox WHERE message_id = $1 AND status = 'dead'`, [input.messageId]);
  const row = current.rows[0];
  if (!row) return false;
  const updated = await client.query(
    `UPDATE aegis.agent_outbox SET status = 'pending', dead_at = NULL, dead_reason = NULL, last_error = NULL,
         max_attempts = attempts + $2, next_attempt_at = clock_timestamp(), updated_at = clock_timestamp()
      WHERE message_id = $1 AND status = 'dead'`,
    [input.messageId, input.budget]);
  if ((updated.rowCount ?? 0) !== 1) return false;
  await client.query(
    `INSERT INTO aegis.agent_outbox_actions (tenant_id, message_id, action, operator_ref, reason) VALUES ($1, $2, 'requeue', $3, $4)`,
    [input.tenantId, input.messageId, input.operatorRef, input.reason]);
  await recordMessageEvent(client, { tenantId: input.tenantId, executionId: row.execution_id, messageId: input.messageId,
    eventType: 'requeued', actorAgent: null, fencingToken: null, reason: input.reason });
  return true;
}

/** Retention: deletes delivered messages older than the cutoff, for one tenant. Dead and undelivered messages are never purged. */
export async function purgeDelivered(client: TenantQueryable, tenantId: string, olderThanHours: number): Promise<number> {
  const result = await client.query(
    `DELETE FROM aegis.agent_outbox WHERE tenant_id = $1 AND status = 'delivered'
        AND delivered_at < clock_timestamp() - make_interval(hours => $2)`,
    [tenantId, olderThanHours]);
  return result.rowCount ?? 0;
}

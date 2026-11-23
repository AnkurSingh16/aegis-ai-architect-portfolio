import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { TenantQueryable } from '../../security/tool-approval-store.js';
import { createAgentExecutionStore, joinTransaction, type ExecutionHooks } from '../persistence/execution-store.js';
import { recordMessageEvent, enqueueMessage } from './outbox.js';
import { withMessagingContext } from './context.js';
import { ROOT_AGENT, STEP_ACTIONS } from './workflow.js';
import { advanceOnResult, handleRequest, TransientRefusal, type AdvanceEffect } from './handlers.js';
import { buildWireMessage, payloadDigest, validateWireMessage, type WireRefusal } from './wire.js';

/**
 * Transactional inbox. A received message is processed in one transaction:
 *   1. the inbox row for (receiver, message) is inserted first, so repeated or concurrent deliveries serialise on the unique key;
 *   2. the P4 store consumes the envelope's single-use grant under the execution lock (recipient path, no lease);
 *   3. the receiving agent's handler runs: a request produces its typed result, a result advances the orchestrator's stage machine;
 *   4. any reply message is enqueued, and the receipt is marked processed. The commit makes all of it visible together.
 * A repeated delivery returns the stored outcome and runs no effect again. Transient refusals roll back and are never recorded.
 */

export type ReceiveStatus = 'processed' | 'duplicate' | 'refused' | 'transient';

export interface ReceiveResult {
  readonly httpStatus: number;
  readonly status: ReceiveStatus;
  readonly reason: string | null;
  readonly resultMessageId: string | null;
  readonly resultDigest: string | null;
}

const TRANSIENT = new Set(['lease_held', 'in_progress', 'not_found', 'unexpected_stage']);

const refused = (httpStatus: number, reason: string): ReceiveResult => ({ httpStatus, status: 'refused', reason,
  resultMessageId: null, resultDigest: null });

export async function receiveMessage(pool: Pool, hooks: ExecutionHooks, input: {
  receiver: string; peerSpiffeId: string; messageId: string; body: unknown; orchestrator?: { spiffeId: string; instance: string };
}): Promise<ReceiveResult> {
  // The sender is the verified peer, resolved through the registrations. Nothing in the body names the sender.
  const who = await withMessagingContext(pool, {}, async (client) => {
    const r = await client.query<{ agent_id: string }>(
      `SELECT agent_id FROM aegis.agent_registrations WHERE spiffe_id = $1 AND status = 'active'`, [input.peerSpiffeId]);
    return r.rows[0]?.agent_id ?? null;
  });
  if (!who) return refused(403, 'unknown_peer');

  const validated = validateWireMessage(input.body, input.messageId);
  if (!validated.ok) return refused(422, validated.reason satisfies WireRefusal);
  const message = validated.message;

  try {
    return await withMessagingContext(pool, { tenantId: message.tenantId }, async (client: TenantQueryable) => {
      // The execution must exist in the message's tenant. Under tenant scope a foreign tenant's execution is simply not visible.
      const execution = await client.query('SELECT 1 FROM aegis.agent_executions WHERE execution_id = $1', [message.executionId]);
      if (execution.rows.length === 0) return refused(409, 'not_found');

      const inserted = await client.query<{ message_id: string }>(
        `INSERT INTO aegis.agent_inbox (receiver_agent, message_id, tenant_id, execution_id, sender_agent, kind, payload_digest)
         VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (receiver_agent, message_id) DO NOTHING RETURNING message_id`,
        [input.receiver, message.messageId, message.tenantId, message.executionId, who, message.kind, message.payloadDigest]);
      if (inserted.rows.length === 0) {
        // Repeated delivery. The committed row decides the answer; the local effect is not run again.
        const prior = (await client.query<{ outcome: string; refusal_reason: string | null; result_message_id: string | null; result_digest: string | null }>(
          `SELECT outcome, refusal_reason, result_message_id, result_digest FROM aegis.agent_inbox WHERE receiver_agent = $1 AND message_id = $2`,
          [input.receiver, message.messageId])).rows[0];
        await recordMessageEvent(client, { tenantId: message.tenantId, executionId: message.executionId, messageId: message.messageId,
          eventType: 'inbox_duplicate', actorAgent: input.receiver, fencingToken: null, reason: prior?.outcome ?? null });
        if (prior?.outcome === 'processed') {
          return { httpStatus: 200, status: 'duplicate' as const, reason: null, resultMessageId: prior.result_message_id, resultDigest: prior.result_digest };
        }
        if (prior?.outcome === 'refused') return { httpStatus: 409, status: 'refused' as const, reason: prior.refusal_reason, resultMessageId: null, resultDigest: null };
        throw new TransientRefusal('in_progress');
      }

      const store = createAgentExecutionStore(joinTransaction(client, message.tenantId), hooks);
      const consumed = await store.receiveEnvelope({ tenantId: message.tenantId, executionId: message.executionId, recipient: input.receiver,
        sender: who, envelope: message.envelope });
      if (!consumed.ok) {
        if (TRANSIENT.has(consumed.reason)) throw new TransientRefusal(consumed.reason);
        return recordRefusal(client, message, input.receiver, consumed.reason);
      }

      if (message.kind === 'result' && input.receiver === ROOT_AGENT) {
        if (!input.orchestrator) throw new TransientRefusal('orchestrator_identity_missing');
        const effect: AdvanceEffect = await advanceOnResult({ client, hooks, tenantId: message.tenantId, executionId: message.executionId,
          sender: who, payload: message.payload, orchestrator: input.orchestrator }).catch((error: unknown) => {
          if (error instanceof TransientRefusal) throw error;
          throw new TransientRefusal('advance_failed');
        });
        // A cancelled or discarded result is consumed and recorded as processed: it has no further effect, and the sender must not retry.
        return finishProcessed(client, message, input.receiver, consumed.value.grantId, null, payloadDigest(message.payload),
          effect.reason ?? effect.effect);
      }

      if (message.kind === 'request' && input.receiver !== ROOT_AGENT) {
        const effect = await handleRequest(client, { receiver: input.receiver, tenantId: message.tenantId, payload: message.payload });
        if ('refused' in effect) return recordRefusal(client, message, input.receiver, effect.refused);
        const resultMessageId = randomUUID();
        const reply = buildWireMessage({ messageId: resultMessageId, tenantId: message.tenantId, executionId: message.executionId, kind: 'result',
          payload: effect.result,
          envelope: { kind: 'result', executionId: message.executionId, tenantId: message.tenantId,
            principalRef: String(message.envelope.principalRef), from: input.receiver, to: who, depth: Number(message.envelope.depth),
            chainDigest: String(message.envelope.chainDigest), action: effect.resultAction, argumentsDigest: String(message.envelope.argumentsDigest) } });
        await enqueueMessage(client, { messageId: resultMessageId, tenantId: message.tenantId, executionId: message.executionId, sender: input.receiver,
          destination: who, kind: 'result', envelope: reply.envelope, payload: reply.payload, payloadDigest: reply.payloadDigest, maxAttempts: 6 });
        return finishProcessed(client, message, input.receiver, consumed.value.grantId, resultMessageId, reply.payloadDigest, 'processed');
      }

      return recordRefusal(client, message, input.receiver, 'unexpected_message_kind');
    });
  } catch (error) {
    if (error instanceof TransientRefusal) {
      return { httpStatus: 503, status: 'transient', reason: error.reason, resultMessageId: null, resultDigest: null };
    }
    throw error;
  }
}

async function finishProcessed(client: TenantQueryable, message: { messageId: string; tenantId: string; executionId: string },
  receiver: string, grantId: string, resultMessageId: string | null, digest: string, reason: string): Promise<ReceiveResult> {
  await client.query(
    `UPDATE aegis.agent_inbox SET outcome = 'processed', grant_id = $3, result_message_id = $4, result_digest = $5, decided_at = clock_timestamp()
      WHERE receiver_agent = $1 AND message_id = $2`,
    [receiver, message.messageId, grantId, resultMessageId, digest]);
  await recordMessageEvent(client, { tenantId: message.tenantId, executionId: message.executionId, messageId: message.messageId,
    eventType: 'inbox_processed', actorAgent: receiver, fencingToken: null, reason: reason.length > 0 && /^[a-z_]{1,40}$/.test(reason) ? reason : null });
  return { httpStatus: 200, status: 'processed', reason: null, resultMessageId, resultDigest: digest };
}

async function recordRefusal(client: TenantQueryable, message: { messageId: string; tenantId: string; executionId: string }, receiver: string,
  reason: string): Promise<ReceiveResult> {
  await client.query(
    `UPDATE aegis.agent_inbox SET outcome = 'refused', refusal_reason = $3, decided_at = clock_timestamp()
      WHERE receiver_agent = $1 AND message_id = $2`, [receiver, message.messageId, reason]);
  await recordMessageEvent(client, { tenantId: message.tenantId, executionId: message.executionId, messageId: message.messageId,
    eventType: 'inbox_refused', actorAgent: receiver, fencingToken: null, reason });
  return refused(409, reason);
}

export { STEP_ACTIONS };

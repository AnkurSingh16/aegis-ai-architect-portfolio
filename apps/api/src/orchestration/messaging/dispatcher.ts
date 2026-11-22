import { performance } from 'node:perf_hooks';
import type { Pool } from 'pg';
import { backoffSeconds } from './backoff.js';
import { withMessagingContext } from './context.js';
import { acknowledgeDelivery, claimDueMessages, deadLetter, deadLetterExhaustedLeases, recordMessageEvent, scheduleRetry, type ClaimedMessage } from './outbox.js';
import type { MessagingTelemetry } from './telemetry.js';
import { MAX_BODY_BYTES } from './wire.js';

/**
 * The P5 dispatcher. It is a loop inside the agent runtime process, and it is also a standalone command (see runtime.ts), so it runs
 * as its own process. It delivers only through the local egress proxy, which performs the SPIFFE-authenticated mTLS to the peer. It
 * never opens a network connection to a peer itself.
 *
 * Outcomes, each recorded as a fenced database write:
 * - 200 from the peer means the peer committed its inbox transaction. The dispatcher acknowledges (delivered).
 * - A transport failure or 5xx/429 means retry with backoff. When the attempt budget is spent, the message is dead-lettered.
 * - A permanent refusal (identity refused, unknown destination, invalid message, refused grant) dead-letters at once, with its reason.
 * A message is never discarded: the only terminal states are delivered and dead, and dead rows stay until an operator acts.
 *
 * Delivery is at-least-once. A crash after the peer commits but before the acknowledgement re-sends the message, and the inbox returns the
 * stored outcome. No external business effect is claimed.
 */

export interface DispatcherConfig {
  readonly pool: Pool;
  readonly agentId: string;
  readonly instance: string;
  readonly egressUrl: string;
  readonly leaseSeconds: number;
  readonly batchSize: number;
  readonly deliveryTimeoutMs: number;
  readonly telemetry: MessagingTelemetry;
  readonly random?: () => number;
  /** Test seams for crash tests. Production passes none. They run at the exact point a process could crash. */
  readonly testHooks?: {
    readonly beforeDeliver?: (message: ClaimedMessage) => Promise<void>;
    readonly afterDeliver?: (message: ClaimedMessage) => Promise<void>;
    readonly beforeAck?: (message: ClaimedMessage) => Promise<void>;
  };
}

export interface DispatchSummary { claimed: number; delivered: number; retried: number; dead: number; ackRefused: number; recovered: number }

const PERMANENT: Record<number, string> = {
  400: 'bad_request', 403: 'peer_identity_refused', 404: 'unknown_destination', 409: 'receiver_refused', 422: 'invalid_message',
};

export async function dispatchOnce(config: DispatcherConfig): Promise<DispatchSummary> {
  const summary: DispatchSummary = { claimed: 0, delivered: 0, retried: 0, dead: 0, ackRefused: 0, recovered: 0 };

  // Expired leases with no attempts left are dead-lettered first, so the claim below never re-sends them.
  const swept = await withMessagingContext(config.pool, { agentId: config.agentId }, (client) => deadLetterExhaustedLeases(client, config.agentId));
  for (const row of swept) {
    await withMessagingContext(config.pool, { tenantId: row.tenant_id, agentId: config.agentId }, (client) => recordMessageEvent(client, {
      tenantId: row.tenant_id, executionId: row.execution_id, messageId: row.message_id, eventType: 'dead_lettered', actorAgent: config.agentId,
      fencingToken: null, reason: 'retry_exhausted' }));
    config.telemetry.deliveryDecision('dead', 'retry_exhausted', config.agentId);
    summary.dead += 1;
  }

  const claimed = await withMessagingContext(config.pool, { agentId: config.agentId }, (client) => claimDueMessages(client, {
    sender: config.agentId, limit: config.batchSize, instance: config.instance, leaseSeconds: config.leaseSeconds }));
  summary.claimed = claimed.length;
  for (const message of claimed) {
    if (message.previousStatus === 'leased') {
      summary.recovered += 1;
      config.telemetry.recoveries(config.agentId);
    }
    await deliverOne(config, message, summary);
  }
  return summary;
}

async function deliverOne(config: DispatcherConfig, message: ClaimedMessage, summary: DispatchSummary): Promise<void> {
  const fence = { messageId: message.messageId, fencingToken: message.fencingToken };
  const scope = { tenantId: message.tenantId, agentId: config.agentId };
  await config.telemetry.span('aegis.message.deliver', {
    'aegis.message.id': message.messageId, 'aegis.execution.id': message.executionId, 'aegis.message.sender': config.agentId,
    'aegis.message.destination': message.destination, 'aegis.message.attempt': message.attempts,
  }, async (setOutcome) => {
    const started = performance.now();
    const body = JSON.stringify({ schemaVersion: 1, messageId: message.messageId, tenantId: message.tenantId, executionId: message.executionId,
      kind: message.kind, envelope: message.envelope, payload: message.payload, payloadDigest: message.payloadDigest });
    if (Buffer.byteLength(body, 'utf8') > MAX_BODY_BYTES) {
      await finish(config, scope, message, fence, 'dead', { deadReason: 'invalid_message', lastError: 'invalid_message' }, 0, summary);
      setOutcome('dead', 'invalid_message');
      return;
    }
    let status: number | null = null;
    let peerBody: { status?: string; reason?: string } | null = null;
    await config.testHooks?.beforeDeliver?.(message);
    try {
      const response = await fetch(`${config.egressUrl}/v1/deliver`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-aegis-destination': message.destination },
        body,
        signal: AbortSignal.timeout(config.deliveryTimeoutMs),
      });
      status = response.status;
      const text = await response.text();
      try { peerBody = text.length > 0 ? JSON.parse(text) as { status?: string; reason?: string } : null; } catch { peerBody = null; }
    } catch {
      status = null;
    }
    config.telemetry.deliveryDuration(performance.now() - started, config.agentId);
    await config.testHooks?.afterDeliver?.(message);

    if (status === 200 && (peerBody?.status === 'processed' || peerBody?.status === 'duplicate')) {
      await config.testHooks?.beforeAck?.(message);
      const ok = await withMessagingContext(config.pool, scope, async (client) => {
        const acknowledged = await acknowledgeDelivery(client, fence);
        await recordMessageEvent(client, { tenantId: message.tenantId, executionId: message.executionId, messageId: message.messageId,
          eventType: acknowledged ? 'delivered' : 'ack_refused', actorAgent: config.agentId, fencingToken: message.fencingToken,
          reason: acknowledged ? null : 'stale_lease' });
        return acknowledged;
      });
      if (ok) {
        summary.delivered += 1;
        config.telemetry.deliveryDecision('delivered', null, config.agentId);
        config.telemetry.attempts(message.attempts, config.agentId);
        setOutcome('delivered');
      } else {
        summary.ackRefused += 1;
        config.telemetry.deliveryDecision('ack_refused', 'stale_lease', config.agentId);
        setOutcome('ack_refused', 'stale_lease');
      }
      return;
    }

    const permanent = status !== null && (PERMANENT[status] !== undefined || (status >= 400 && status < 500 && status !== 408 && status !== 425 && status !== 429));
    const reason = status === null ? 'peer_unreachable' : (PERMANENT[status] ?? peerBody?.reason ?? 'peer_unreachable');
    if (permanent || message.attempts >= message.maxAttempts) {
      const deadReason = permanent ? reason : 'retry_exhausted';
      await finish(config, scope, message, fence, 'dead', { deadReason, lastError: reason }, 0, summary);
      setOutcome('dead', deadReason);
      return;
    }
    const delay = backoffSeconds(message.attempts, config.random);
    await finish(config, scope, message, fence, 'retry', { deadReason: reason, lastError: reason }, delay, summary);
    setOutcome('retry', reason);
  });
}

async function finish(config: DispatcherConfig, scope: { tenantId: string; agentId: string }, message: ClaimedMessage,
  fence: { messageId: string; fencingToken: number }, outcome: 'retry' | 'dead', reason: { deadReason: string; lastError: string }, delay: number,
  summary: DispatchSummary): Promise<void> {
  const applied = await withMessagingContext(config.pool, scope, async (client) => {
    const changed = outcome === 'dead'
      ? await deadLetter(client, fence, reason)
      : await scheduleRetry(client, fence, { delaySeconds: delay, reason: reason.lastError });
    await recordMessageEvent(client, { tenantId: message.tenantId, executionId: message.executionId, messageId: message.messageId,
      eventType: !changed ? 'ack_refused' : outcome === 'dead' ? 'dead_lettered' : 'retry_scheduled', actorAgent: config.agentId,
      fencingToken: message.fencingToken, reason: changed ? reason.lastError : 'stale_lease' });
    return changed;
  });
  if (!applied) {
    summary.ackRefused += 1;
    config.telemetry.deliveryDecision('ack_refused', 'stale_lease', config.agentId);
    return;
  }
  if (outcome === 'dead') {
    summary.dead += 1;
    config.telemetry.deliveryDecision('dead', reason.deadReason, config.agentId);
    config.telemetry.attempts(message.attempts, config.agentId);
  } else {
    summary.retried += 1;
    config.telemetry.deliveryDecision('retry', reason.lastError, config.agentId);
  }
}

/** Samples the backlog for the gauges. Read-only and scoped to this agent's own sender rows. */
export async function sampleBacklog(pool: Pool, agentId: string, telemetry: MessagingTelemetry): Promise<{ pending: number; oldest: number }> {
  const row = await withMessagingContext(pool, { agentId }, async (client) => {
    const result = await client.query<{ pending: string; oldest: string | null }>(
      `SELECT count(*)::text AS pending, COALESCE(EXTRACT(EPOCH FROM clock_timestamp() - min(created_at)), 0)::text AS oldest
         FROM aegis.agent_outbox WHERE sender_agent = $1 AND status IN ('pending', 'leased')`, [agentId]);
    return result.rows[0];
  });
  const sample = { pending: Number(row.pending), oldest: Number(row.oldest ?? 0) };
  telemetry.setBacklog(sample.pending, sample.oldest, agentId);
  return sample;
}

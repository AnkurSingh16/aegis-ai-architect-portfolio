import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { createAgentExecutionStore, joinTransaction, type ExecutionHooks } from '../persistence/execution-store.js';
import { enqueueMessage, recordMessageEvent } from './outbox.js';
import { withMessagingContext } from './context.js';
import { ACTION_RESULT, parseTriageArguments, triageEffect, TRIAGE_AGENT } from './workflow.js';
import { buildWireMessage, payloadDigest, validateWireMessage, type WireRefusal } from './wire.js';

/**
 * P5 transactional inbox. A received message is processed in ONE transaction:
 *   1. the inbox row for (receiver, message id) is inserted first, so concurrent or repeated deliveries serialise on the unique key;
 *   2. the P4 store consumes the envelope's single-use grant under the execution lock (recipient path, no lease);
 *   3. the deterministic local effect is computed and any result message is enqueued;
 *   4. the inbox row records the outcome and the commit makes all of it visible at once.
 * A repeated delivery finds the committed row and returns its stored outcome, so the local effect runs once per message. A transaction that
 * fails before commit leaves no inbox row, so the message is processed again on redelivery. Transient refusals roll back and are never recorded.
 */

export type ReceiveStatus = 'processed' | 'duplicate' | 'refused' | 'transient';

export interface ReceiveResult {
  readonly httpStatus: number;
  readonly status: ReceiveStatus;
  readonly reason: string | null;
  readonly resultMessageId: string | null;
  readonly resultDigest: string | null;
}

/** Refusals that depend on timing rather than on the message. These roll back and ask the sender to retry. */
const TRANSIENT = new Set(['lease_held']);

class TransientRefusal extends Error {
  constructor(readonly reason: string) { super(reason); }
}

const refused = (httpStatus: number, reason: string): ReceiveResult => ({ httpStatus, status: 'refused', reason,
  resultMessageId: null, resultDigest: null });

export async function receiveMessage(pool: Pool, hooks: ExecutionHooks, input: {
  receiver: string; peerSpiffeId: string; messageId: string; body: unknown;
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
    return await withMessagingContext(pool, { tenantId: message.tenantId, agentId: input.receiver }, async (client) => {
      // The execution must exist in the message's tenant. Under tenant scope a foreign tenant's execution is simply not visible.
      const execution = await client.query('SELECT 1 FROM aegis.agent_executions WHERE execution_id = $1', [message.executionId]);
      if (execution.rows.length === 0) {
        return { httpStatus: 409, status: 'refused' as const, reason: 'not_found', resultMessageId: null, resultDigest: null };
      }
      const inserted = await client.query<{ message_id: string }>(
        `INSERT INTO aegis.agent_inbox (receiver_agent, message_id, tenant_id, execution_id, sender_agent, kind, payload_digest)
         VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (receiver_agent, message_id) DO NOTHING RETURNING message_id`,
        [input.receiver, message.messageId, message.tenantId, message.executionId, who, message.kind, message.payloadDigest]);
      if (inserted.rows.length === 0) {
        // Repeated delivery. The committed row decides the answer; the local effect is not run again.
        const prior = await client.query<{ outcome: string; refusal_reason: string | null; result_message_id: string | null; result_digest: string | null }>(
          `SELECT outcome, refusal_reason, result_message_id, result_digest FROM aegis.agent_inbox WHERE receiver_agent = $1 AND message_id = $2`,
          [input.receiver, message.messageId]);
        const row = prior.rows[0];
        await recordMessageEvent(client, { tenantId: message.tenantId, executionId: message.executionId, messageId: message.messageId,
          eventType: 'inbox_duplicate', actorAgent: who, fencingToken: null, reason: row?.outcome ?? null });
        if (row?.outcome === 'processed') {
          return { httpStatus: 200, status: 'duplicate' as const, reason: null, resultMessageId: row.result_message_id,
            resultDigest: row.result_digest };
        }
        if (row?.outcome === 'refused') return { httpStatus: 409, status: 'refused' as const, reason: row.refusal_reason, resultMessageId: null, resultDigest: null };
        throw new TransientRefusal('in_progress');
      }

      // Triage only performs its one typed effect. Arguments that do not have that shape are refused before any grant is consumed.
      const typedArguments = message.kind === 'request' && input.receiver === TRIAGE_AGENT ? parseTriageArguments(message.payload.arguments) : null;
      if (message.kind === 'request' && input.receiver === TRIAGE_AGENT && !typedArguments) {
        await client.query(
          `UPDATE aegis.agent_inbox SET outcome = 'refused', refusal_reason = 'invalid_arguments', decided_at = clock_timestamp()
            WHERE receiver_agent = $1 AND message_id = $2`, [input.receiver, message.messageId]);
        await recordMessageEvent(client, { tenantId: message.tenantId, executionId: message.executionId, messageId: message.messageId,
          eventType: 'inbox_refused', actorAgent: input.receiver, fencingToken: null, reason: 'invalid_arguments' });
        return { httpStatus: 409, status: 'refused' as const, reason: 'invalid_arguments', resultMessageId: null, resultDigest: null };
      }

      const store = createAgentExecutionStore(joinTransaction(client, message.tenantId), hooks);
      const consumed = await store.receiveEnvelope({ tenantId: message.tenantId, executionId: message.executionId, recipient: input.receiver,
        sender: who, envelope: message.envelope });
      if (!consumed.ok) {
        if (TRANSIENT.has(consumed.reason)) throw new TransientRefusal(consumed.reason);
        await client.query(
          `UPDATE aegis.agent_inbox SET outcome = 'refused', refusal_reason = $3, decided_at = clock_timestamp()
            WHERE receiver_agent = $1 AND message_id = $2`, [input.receiver, message.messageId, consumed.reason]);
        await recordMessageEvent(client, { tenantId: message.tenantId, executionId: message.executionId, messageId: message.messageId,
          eventType: 'inbox_refused', actorAgent: input.receiver, fencingToken: null, reason: consumed.reason });
        return { httpStatus: 409, status: 'refused' as const, reason: consumed.reason, resultMessageId: null, resultDigest: null };
      }

      let resultMessageId: string | null = null;
      let effectDigest: string;
      if (message.kind === 'request' && input.receiver === TRIAGE_AGENT) {
        const result = triageEffect(typedArguments!) as unknown as Record<string, unknown>;
        resultMessageId = randomUUID();
        const reply = buildWireMessage({ messageId: resultMessageId, tenantId: message.tenantId, executionId: message.executionId,
          kind: 'result', payload: { result },
          envelope: { kind: 'result', executionId: message.executionId, tenantId: message.tenantId,
            principalRef: String(message.envelope.principalRef), from: input.receiver, to: who, depth: Number(message.envelope.depth),
            chainDigest: String(message.envelope.chainDigest), action: ACTION_RESULT, argumentsDigest: String(message.envelope.argumentsDigest) } });
        await enqueueMessage(client, { messageId: resultMessageId, tenantId: message.tenantId, executionId: message.executionId,
          sender: input.receiver, destination: who, kind: 'result', envelope: reply.envelope, payload: reply.payload,
          payloadDigest: reply.payloadDigest, maxAttempts: 6 });
        // The digest recorded is the digest of the message payload that was sent, so the receipt and the message agree.
        effectDigest = reply.payloadDigest;
      } else {
        effectDigest = payloadDigest(message.payload);
      }

      await client.query(
        `UPDATE aegis.agent_inbox SET outcome = 'processed', grant_id = $3, result_message_id = $4, result_digest = $5, decided_at = clock_timestamp()
          WHERE receiver_agent = $1 AND message_id = $2`,
        [input.receiver, message.messageId, consumed.value.grantId, resultMessageId, effectDigest]);
      await recordMessageEvent(client, { tenantId: message.tenantId, executionId: message.executionId, messageId: message.messageId,
        eventType: 'inbox_processed', actorAgent: input.receiver, fencingToken: null, reason: null });
      return { httpStatus: 200, status: 'processed' as const, reason: null, resultMessageId, resultDigest: effectDigest };
    });
  } catch (error) {
    if (error instanceof TransientRefusal) {
      return { httpStatus: 503, status: 'transient', reason: error.reason, resultMessageId: null, resultDigest: null };
    }
    throw error;
  }
}


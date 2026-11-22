import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { delegateAndDispatch, ACTION_REQUEST, ACTION_RESULT, TRIAGE_AGENT, WORKFLOW_SCOPES } from './workflow.js';
import { dispatchOnce } from './dispatcher.js';
import { receiveMessage } from './inbox.js';
import { acknowledgeDelivery, claimDueMessages, requeueDeadMessage, purgeDelivered } from './outbox.js';
import { withMessagingContext } from './context.js';
import { createMessagingTelemetry } from './telemetry.js';
import { buildWireMessage, payloadDigest } from './wire.js';
import { argumentsDigest } from '../delegation.js';
import { createHarness, readRequestWire, SPIFFE, sleep, startExecution, startStubEgress, wireBody, type Harness, type StubEgress } from './testing/support.js';

// P5 in real PostgreSQL, in one process, with the real inbox, outbox, dispatcher and P4 store. The transport is a stub that picks the
// verified peer identity; mTLS and the SPIRE identity path are exercised by the containerised acceptance (scripts/p5-acceptance.mjs).

let h: Harness;
const stubs: StubEgress[] = [];
const telemetry = createMessagingTelemetry();
const dispatcher = (agentId: string, egressUrl: string, extra: Partial<Parameters<typeof dispatchOnce>[0]> = {}) => dispatchOnce({
  pool: h.pool, agentId, instance: `${agentId}-test`, egressUrl, leaseSeconds: 30, batchSize: 8, deliveryTimeoutMs: 5000, telemetry, ...extra,
});
const count = async (sql: string, values: unknown[] = []) => Number((await h.adminPool.query<{ n: string }>(sql, values)).rows[0].n);

beforeAll(async () => { h = await createHarness(); });
// Each test starts with no undelivered messages from earlier tests, so dispatcher summaries describe only that test's messages.
// The drain is an administrator action in the test database; it moves leftovers to dead letter with a test reason, never deletes them.
beforeEach(async () => {
  await h.adminPool.query(`UPDATE aegis.agent_outbox SET status = 'dead', dead_at = clock_timestamp(), dead_reason = 'retry_exhausted',
    lease_instance = NULL, lease_expires_at = NULL WHERE status IN ('pending', 'leased')`);
});
afterAll(async () => {
  for (const stub of stubs) await stub.close();
  await h?.pool.end();
  await h?.adminPool.end();
});

async function stubsFor(): Promise<{ orchestrator: StubEgress; triage: StubEgress }> {
  const orchestrator = await startStubEgress(h.pool, SPIFFE.orchestrator);
  const triage = await startStubEgress(h.pool, SPIFFE.triage);
  stubs.push(orchestrator, triage);
  return { orchestrator, triage };
}

describe('the decision and its message commit together', () => {
  it('a successful delegation commits the hop, both grants, the request message and the lease release in one transaction', async () => {
    const started = await startExecution(h);
    expect(await count('SELECT count(*)::text AS n FROM aegis.agent_delegations WHERE execution_id = $1', [started.executionId])).toBe(1);
    expect(await count('SELECT count(*)::text AS n FROM aegis.agent_grants WHERE execution_id = $1 AND status = \'open\'', [started.executionId])).toBe(2);
    const message = await h.adminPool.query<{ status: string; kind: string; destination_agent: string; envelope: Record<string, unknown> }>(
      'SELECT status, kind, destination_agent, envelope FROM aegis.agent_outbox WHERE message_id = $1', [started.requestMessageId]);
    expect(message.rows[0]).toMatchObject({ status: 'pending', kind: 'request', destination_agent: 'triage' });
    expect(message.rows[0].envelope).toMatchObject({ from: 'orchestrator', to: 'triage', action: ACTION_REQUEST });
    const execution = await h.adminPool.query<{ status: string; fencing_token: string }>(
      'SELECT status, fencing_token::text AS fencing_token FROM aegis.agent_executions WHERE execution_id = $1', [started.executionId]);
    expect(execution.rows[0].status).toBe('pending');
  });

  it('a refused delegation leaves no hop, grant or message, and records only the refusal', async () => {
    const created = await h.store.createExecution({ tenantId: h.tenantA, idempotencyKey: randomUUID(), principalRef: 'd'.repeat(64),
      principalScopes: ['case:read'], limits: { maxDepth: 3, maxDelegations: 4, maxSteps: 8 }, grantTtlSeconds: 300, maxAttempts: 6 });
    const claim = await h.store.claim({ tenantId: h.tenantA, executionId: created.executionId, spiffeId: SPIFFE.orchestrator, instance: 'x', leaseSeconds: 60 });
    if (!claim.ok) throw new Error('claim');
    const outcome = await delegateAndDispatch(h.pool, {}, { tenantId: h.tenantA, fence: { tenantId: h.tenantA, executionId: created.executionId,
      agentId: claim.value.agentId, instance: 'x', fencingToken: claim.value.fencingToken }, to: TRIAGE_AGENT, requestedScopes: ['case:write'],
    action: ACTION_REQUEST, resultAction: ACTION_RESULT, arguments: { caseRef: randomUUID(), documentCount: 1, questionCode: 'status_check' } });
    expect(outcome).toEqual({ ok: false, reason: 'scope_escalation' });
    expect(await count('SELECT count(*)::text AS n FROM aegis.agent_outbox WHERE execution_id = $1', [created.executionId])).toBe(0);
    expect(await count('SELECT count(*)::text AS n FROM aegis.agent_grants WHERE execution_id = $1', [created.executionId])).toBe(0);
    expect(await count('SELECT count(*)::text AS n FROM aegis.agent_execution_events WHERE execution_id = $1 AND event_type = \'delegation_refused\'', [created.executionId])).toBe(1);
  });

  it('a decision that fails before commit leaves no deliverable message and no grant', async () => {
    const created = await h.store.createExecution({ tenantId: h.tenantA, idempotencyKey: randomUUID(), principalRef: 'e'.repeat(64),
      principalScopes: ['case:read', 'document:read'], limits: { maxDepth: 3, maxDelegations: 4, maxSteps: 8 }, grantTtlSeconds: 300, maxAttempts: 6 });
    const claim = await h.store.claim({ tenantId: h.tenantA, executionId: created.executionId, spiffeId: SPIFFE.orchestrator, instance: 'x', leaseSeconds: 60 });
    if (!claim.ok) throw new Error('claim');
    await expect(delegateAndDispatch(h.pool, { beforeCommit: async (label) => {
      if (label === 'grant:accepted') throw new Error('injected failure before commit');
    } }, { tenantId: h.tenantA, fence: { tenantId: h.tenantA, executionId: created.executionId, agentId: claim.value.agentId, instance: 'x',
      fencingToken: claim.value.fencingToken }, to: TRIAGE_AGENT, requestedScopes: [...WORKFLOW_SCOPES], action: ACTION_REQUEST, resultAction: ACTION_RESULT,
    arguments: { caseRef: randomUUID(), documentCount: 1, questionCode: 'status_check' } })).rejects.toThrow('injected failure');
    expect(await count('SELECT count(*)::text AS n FROM aegis.agent_outbox WHERE execution_id = $1', [created.executionId])).toBe(0);
    expect(await count('SELECT count(*)::text AS n FROM aegis.agent_grants WHERE execution_id = $1', [created.executionId])).toBe(0);
    expect(await count('SELECT count(*)::text AS n FROM aegis.agent_delegations WHERE execution_id = $1', [created.executionId])).toBe(0);
  });
});

describe('end to end: dispatch, inbox, result, finalisation', () => {
  it('the request is delivered, triage consumes its grant and returns one result, and the orchestrator finalises the execution', async () => {
    const { orchestrator, triage } = await stubsFor();
    const started = await startExecution(h, { documentCount: 3 });
    const sent = await dispatcher('orchestrator', orchestrator.url);
    expect(sent.delivered).toBe(1);
    const reply = await dispatcher('triage', triage.url);
    expect(reply.delivered).toBe(1);
    void started;
    const execution = await h.adminPool.query<{ status: string }>('SELECT status FROM aegis.agent_executions WHERE execution_id = $1', [started.executionId]);
    expect(execution.rows[0].status).toBe('succeeded');
    const inbox = await h.adminPool.query<{ receiver_agent: string; outcome: string; grant_id: string; result_digest: string; result_message_id: string | null }>(
      'SELECT receiver_agent, outcome, grant_id, result_digest, result_message_id FROM aegis.agent_inbox WHERE execution_id = $1 ORDER BY receiver_agent', [started.executionId]);
    expect(inbox.rows.map((r) => [r.receiver_agent, r.outcome])).toEqual([['orchestrator', 'processed'], ['triage', 'processed']]);
    const triageRow = inbox.rows.find((r) => r.receiver_agent === 'triage')!;
    expect(triageRow.result_message_id).not.toBeNull();
    const resultMessage = await h.adminPool.query<{ payload: { result: Record<string, unknown> }; payload_digest: string; status: string }>(
      'SELECT payload, payload_digest, status FROM aegis.agent_outbox WHERE message_id = $1', [triageRow.result_message_id]);
    expect(resultMessage.rows[0].payload.result).toEqual({ verdict: 'documents_present', documentCount: 3, questionCode: 'status_check' });
    expect(resultMessage.rows[0].payload_digest).toBe(triageRow.result_digest);
    expect(resultMessage.rows[0].status).toBe('delivered');
    const grants = await h.adminPool.query<{ kind: string; status: string; consumed_by_agent: string }>(
      'SELECT kind, status, consumed_by_agent FROM aegis.agent_grants WHERE execution_id = $1 ORDER BY kind', [started.executionId]);
    expect(grants.rows).toEqual([{ kind: 'request', status: 'consumed', consumed_by_agent: 'triage' }, { kind: 'result', status: 'consumed', consumed_by_agent: 'orchestrator' }]);
  });

  it('a repeated delivery returns the stored outcome and repeats no local effect', async () => {
    const { orchestrator, triage } = await stubsFor();
    const started = await startExecution(h);
    await dispatcher('orchestrator', orchestrator.url);
    await dispatcher('triage', triage.url);
    const wire = await readRequestWire(h, started);
    const again = await receiveMessage(h.pool, {}, { receiver: 'triage', peerSpiffeId: SPIFFE.orchestrator, messageId: wire.messageId, body: wireBody(wire) });
    expect(again).toMatchObject({ httpStatus: 200, status: 'duplicate' });
    expect(await count('SELECT count(*)::text AS n FROM aegis.agent_outbox WHERE execution_id = $1 AND kind = \'result\'', [started.executionId])).toBe(1);
    expect(await count('SELECT count(*)::text AS n FROM aegis.agent_message_events WHERE execution_id = $1 AND event_type = \'inbox_duplicate\'', [started.executionId])).toBe(1);
  });

  it('concurrent deliveries of one message are processed once', async () => {
    const started = await startExecution(h);
    const wire = await readRequestWire(h, started);
    const body = wireBody(wire);
    const results = await Promise.all(Array.from({ length: 6 }, () =>
      receiveMessage(h.pool, {}, { receiver: 'triage', peerSpiffeId: SPIFFE.orchestrator, messageId: wire.messageId, body })));
    expect(results.filter((r) => r.status === 'processed')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'duplicate')).toHaveLength(5);
    expect(new Set(results.map((r) => r.resultMessageId)).size).toBe(1);
    expect(await count('SELECT count(*)::text AS n FROM aegis.agent_outbox WHERE execution_id = $1 AND kind = \'result\'', [started.executionId])).toBe(1);
    expect(await count('SELECT count(*)::text AS n FROM aegis.agent_grants WHERE execution_id = $1 AND status = \'consumed\'', [started.executionId])).toBe(1);
  });
});

describe('secure message and grant handling', () => {
  it('a payload altered after digesting is refused before any database write', async () => {
    const started = await startExecution(h);
    const wire = await readRequestWire(h, started);
    const body = wireBody(wire) as { payload: { arguments: { documentCount: number } } };
    body.payload.arguments.documentCount = 50;
    const before = await count('SELECT count(*)::text AS n FROM aegis.agent_inbox WHERE execution_id = $1', [started.executionId]);
    const result = await receiveMessage(h.pool, {}, { receiver: 'triage', peerSpiffeId: SPIFFE.orchestrator, messageId: wire.messageId, body });
    expect(result).toMatchObject({ httpStatus: 422, reason: 'payload_digest_mismatch' });
    expect(await count('SELECT count(*)::text AS n FROM aegis.agent_inbox WHERE execution_id = $1', [started.executionId])).toBe(before);
  });

  it('an argument digest that does not match the arguments is refused', async () => {
    const started = await startExecution(h);
    const wire = await readRequestWire(h, started);
    const body = wireBody(wire) as { envelope: Record<string, unknown>; payloadDigest: string; payload: Record<string, unknown> };
    body.envelope.argumentsDigest = argumentsDigest({ other: true });
    const result = await receiveMessage(h.pool, {}, { receiver: 'triage', peerSpiffeId: SPIFFE.orchestrator, messageId: wire.messageId, body });
    expect(result).toMatchObject({ httpStatus: 422, reason: 'arguments_digest_mismatch' });
  });

  it('a replayed grant under a new message identifier is refused as consumed', async () => {
    const { orchestrator } = await stubsFor();
    const started = await startExecution(h);
    await dispatcher('orchestrator', orchestrator.url);
    const wire = await readRequestWire(h, started);
    const replayId = randomUUID();

    const replay = buildWireMessage({ messageId: replayId, tenantId: started.tenantId, executionId: started.executionId, kind: 'request',
      envelope: wire.envelope, payload: wire.payload });
    const result = await receiveMessage(h.pool, {}, { receiver: 'triage', peerSpiffeId: SPIFFE.orchestrator, messageId: replayId, body: replay });
    expect(result).toMatchObject({ httpStatus: 409, status: 'refused', reason: 'grant_consumed' });
  });

  it('a message addressed to another agent is refused by name, not by grant lookup', async () => {
    const started = await startExecution(h);
    const wire = await readRequestWire(h, started);
    const body = wireBody(wire) as { envelope: Record<string, unknown> };
    body.envelope.to = 'retrieval';
    const result = await receiveMessage(h.pool, {}, { receiver: 'triage', peerSpiffeId: SPIFFE.orchestrator, messageId: wire.messageId, body });
    expect(result).toMatchObject({ httpStatus: 409, reason: 'wrong_recipient' });
  });

  it('a verified peer that is not the envelope sender is refused, whatever the envelope says', async () => {
    const started = await startExecution(h);
    const wire = await readRequestWire(h, started);
    const result = await receiveMessage(h.pool, {}, { receiver: 'triage', peerSpiffeId: SPIFFE.reviewer, messageId: wire.messageId, body: wireBody(wire) });
    expect(result).toMatchObject({ httpStatus: 409, reason: 'sender_mismatch' });
  });

  it('an identity that is not registered cannot deliver anything', async () => {
    const started = await startExecution(h);
    const wire = await readRequestWire(h, started);
    const result = await receiveMessage(h.pool, {}, { receiver: 'triage', peerSpiffeId: SPIFFE.unregistered, messageId: wire.messageId, body: wireBody(wire) });
    expect(result).toMatchObject({ httpStatus: 403, reason: 'unknown_peer' });
    expect(await count('SELECT count(*)::text AS n FROM aegis.agent_inbox WHERE message_id = $1', [wire.messageId])).toBe(0);
  });

  it('a message naming another tenant\'s execution is refused as not found in its own tenant', async () => {
    const started = await startExecution(h, { tenantId: h.tenantA });
    const wire = await readRequestWire(h, started);
    const body = wireBody({ ...wire, tenantId: h.tenantB, envelope: { ...wire.envelope, tenantId: h.tenantB } }) as Record<string, unknown>;
    const result = await receiveMessage(h.pool, {}, { receiver: 'triage', peerSpiffeId: SPIFFE.orchestrator, messageId: wire.messageId, body: { ...body, payloadDigest: payloadDigest(wire.payload) } });
    expect(result).toMatchObject({ httpStatus: 409, reason: 'not_found' });
    expect(await count('SELECT count(*)::text AS n FROM aegis.agent_inbox WHERE message_id = $1', [wire.messageId])).toBe(0);
  });

  it('an expired grant cannot authorise an envelope', async () => {
    const started = await startExecution(h, { grantTtlSeconds: 1 });
    const wire = await readRequestWire(h, started);
    await sleep(1300);
    const result = await receiveMessage(h.pool, {}, { receiver: 'triage', peerSpiffeId: SPIFFE.orchestrator, messageId: wire.messageId, body: wireBody(wire) });
    expect(result).toMatchObject({ httpStatus: 409, reason: 'not_granted' });
  });
});

describe('dispatcher behaviour and isolation', () => {
  it('a 503 from the receiver is retried with backoff, then dead-lettered after the budget, then recovered by an audited requeue', async () => {
    const orchestrator = await startStubEgress(h.pool, SPIFFE.orchestrator);
    stubs.push(orchestrator);
    orchestrator.mode = 'unavailable';
    const started = await startExecution(h, { maxAttempts: 2 });
    const noJitter = () => 0;
    const first = await dispatcher('orchestrator', orchestrator.url, { random: noJitter });
    expect(first).toMatchObject({ delivered: 0, retried: 1 });
    const pending = await h.adminPool.query<{ status: string; attempts: number; last_error: string; due_in: number }>(
      `SELECT status, attempts, last_error, EXTRACT(EPOCH FROM next_attempt_at - clock_timestamp())::float AS due_in FROM aegis.agent_outbox WHERE message_id = $1`, [started.requestMessageId]);
    expect(pending.rows[0]).toMatchObject({ status: 'pending', attempts: 1, last_error: 'receiver_unavailable' });
    expect(pending.rows[0].due_in).toBeGreaterThan(0);
    await sleep(1000);
    const second = await dispatcher('orchestrator', orchestrator.url, { random: noJitter });
    expect(second).toMatchObject({ dead: 1 });
    const dead = await h.adminPool.query<{ status: string; dead_reason: string; attempts: number }>(
      'SELECT status, dead_reason, attempts FROM aegis.agent_outbox WHERE message_id = $1', [started.requestMessageId]);
    expect(dead.rows[0]).toMatchObject({ status: 'dead', dead_reason: 'retry_exhausted', attempts: 2 });

    orchestrator.mode = 'deliver';
    const requeued = await withMessagingContext(h.pool, { tenantId: started.tenantId }, (client) => requeueDeadMessage(client, {
      tenantId: started.tenantId, messageId: started.requestMessageId, operatorRef: 'a'.repeat(64), reason: 'receiver_recovered', budget: 2 }));
    expect(requeued).toBe(true);
    expect(await count('SELECT count(*)::text AS n FROM aegis.agent_outbox_actions WHERE message_id = $1 AND action = \'requeue\'', [started.requestMessageId])).toBe(1);
    const recovered = await dispatcher('orchestrator', orchestrator.url);
    expect(recovered.delivered).toBe(1);
  });

  it('a permanent refusal dead-letters at once, with its reason, and nothing is dropped', async () => {
    const orchestrator = await startStubEgress(h.pool, SPIFFE.orchestrator);
    stubs.push(orchestrator);
    orchestrator.mode = 'refuse_identity';
    const started = await startExecution(h);
    const summary = await dispatcher('orchestrator', orchestrator.url);
    expect(summary).toMatchObject({ dead: 1, retried: 0 });
    const row = await h.adminPool.query<{ status: string; dead_reason: string }>('SELECT status, dead_reason FROM aegis.agent_outbox WHERE message_id = $1', [started.requestMessageId]);
    expect(row.rows[0]).toEqual({ status: 'dead', dead_reason: 'peer_identity_refused' });
  });

  it('an unreachable peer is retried, never silently dropped', async () => {
    const started = await startExecution(h);
    const summary = await dispatcher('orchestrator', 'http://127.0.0.1:9', { random: () => 0.5 });
    expect(summary.retried).toBeGreaterThanOrEqual(1);
    const row = await h.adminPool.query<{ status: string; last_error: string }>('SELECT status, last_error FROM aegis.agent_outbox WHERE message_id = $1', [started.requestMessageId]);
    expect(row.rows[0]).toEqual({ status: 'pending', last_error: 'peer_unreachable' });
  });

  it('a stale holder\'s acknowledgement is refused after its lease is recovered by another dispatcher', async () => {
    const started = await startExecution(h);
    const first = await withMessagingContext(h.pool, { agentId: 'orchestrator' }, (c) => claimDueMessages(c, { sender: 'orchestrator', limit: 50, instance: 'a', leaseSeconds: 1 }));
    const mine = first.find((m) => m.messageId === started.requestMessageId)!;
    expect(mine.fencingToken).toBe(1);
    await sleep(1100);
    const second = await withMessagingContext(h.pool, { agentId: 'orchestrator' }, (c) => claimDueMessages(c, { sender: 'orchestrator', limit: 50, instance: 'b', leaseSeconds: 30 }));
    const recovered = second.find((m) => m.messageId === started.requestMessageId)!;
    expect(recovered).toMatchObject({ fencingToken: 2, previousStatus: 'leased' });
    const stale = await withMessagingContext(h.pool, { tenantId: started.tenantId, agentId: 'orchestrator' }, (c) =>
      acknowledgeDelivery(c, { messageId: mine.messageId, fencingToken: 1 }));
    expect(stale).toBe(false);
    const fresh = await withMessagingContext(h.pool, { tenantId: started.tenantId, agentId: 'orchestrator' }, (c) =>
      acknowledgeDelivery(c, { messageId: mine.messageId, fencingToken: 2 }));
    expect(fresh).toBe(true);
  });

  it('concurrent claims lease disjoint messages (SKIP LOCKED), so no message is leased twice', async () => {
    for (let i = 0; i < 6; i += 1) await startExecution(h);
    const claims = await Promise.all([0, 1, 2].map((i) => withMessagingContext(h.pool, { agentId: 'orchestrator' }, (c) =>
      claimDueMessages(c, { sender: 'orchestrator', limit: 4, instance: `c${i}`, leaseSeconds: 60 }))));
    const ids = claims.flat().map((m) => m.messageId);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.length).toBeGreaterThanOrEqual(6);
  });

  it('a dispatcher for one agent cannot acknowledge another sender\'s message, and a tenant scope cannot read another tenant', async () => {
    const started = await startExecution(h, { tenantId: h.tenantA });
    const crossAck = await withMessagingContext(h.pool, { tenantId: h.tenantA, agentId: 'triage' }, (c) =>
      acknowledgeDelivery(c, { messageId: started.requestMessageId, fencingToken: 1 }));
    expect(crossAck).toBe(false);
    const seenByOtherTenant = await withMessagingContext(h.pool, { tenantId: h.tenantB }, (c) => c.query<{ n: string }>(
      'SELECT count(*)::text AS n FROM aegis.agent_outbox WHERE execution_id = $1', [started.executionId], ));
    expect(seenByOtherTenant.rows[0].n).toBe('0');
  });

  it('retention never deletes undelivered messages, and refuses to purge inside the retention window', async () => {
    const deleted = await withMessagingContext(h.pool, { tenantId: h.tenantA }, (c) => purgeDelivered(c, h.tenantA, 24));
    expect(deleted).toBe(0);
  });

  it('least privilege at the database: the runtime role cannot rewrite content, forge a processed inbox row, or delete audit', async () => {
    const started = await startExecution(h);
    await expect(h.pool.query('UPDATE aegis.agent_outbox SET payload = \'{}\'::jsonb WHERE message_id = $1', [started.requestMessageId]))
      .rejects.toThrow(/permission denied|42501/);
    await expect(withMessagingContext(h.pool, { tenantId: started.tenantId, agentId: 'triage' }, (c) => c.query(
      `INSERT INTO aegis.agent_inbox (receiver_agent, message_id, tenant_id, execution_id, sender_agent, kind, payload_digest, outcome, grant_id, result_digest, decided_at)
       VALUES ('triage', $1, $2, $3, 'orchestrator', 'request', $4, 'processed', $5, $4, clock_timestamp())`,
      [randomUUID(), started.tenantId, started.executionId, 'f'.repeat(64), randomUUID()]))).rejects.toThrow();
    await expect(h.pool.query('DELETE FROM aegis.agent_message_events WHERE tenant_id = $1', [started.tenantId])).rejects.toThrow(/permission denied|42501/);
  });

  it('the append-only audit cannot be changed even by the table owner (trigger), and delivered messages are final', async () => {
    const { orchestrator } = await stubsFor();
    const started = await startExecution(h);
    expect((await dispatcher('orchestrator', orchestrator.url)).delivered).toBe(1);
    await expect(h.adminPool.query('UPDATE aegis.agent_outbox SET status = \'pending\' WHERE message_id = $1', [started.requestMessageId]))
      .rejects.toThrow(/delivered message is final/);
    await expect(h.adminPool.query('DELETE FROM aegis.agent_message_events WHERE execution_id = $1', [started.executionId]))
      .rejects.toThrow(/append-only/);
  });
});

void SPIFFE;

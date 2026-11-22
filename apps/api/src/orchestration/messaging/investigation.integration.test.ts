import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { ingestSyntheticCatalog } from '../../documents/ingestion.js';
import { dispatchOnce } from './dispatcher.js';
import { createMessagingTelemetry } from './telemetry.js';
import { withMessagingContext } from './context.js';
import { startInvestigationInTx } from './handlers.js';
import { receiveMessage } from './inbox.js';
import { submitInvestigation, readInvestigation, requestCancellation, GatewayError, principalDigest, validateQuestion } from '../../investigation/gateway.js';
import { createHarness, closeHarness, startInvestigation, startStubEgress, readerPrincipal, wireOf, roleUrl, SPIFFE, NORTH, SOUTH, QUESTION,
  TEST_ISSUER, type AgentName, type Harness, type StubEgress } from './testing/support.js';

// P8 end to end on real PostgreSQL: the gateway, the orchestrator's stage machine, triage, retrieval over the seeded synthetic corpus,
// the reviewer and finalisation. Every agent acts through its own database role. The transport is a stub that chooses the verified peer.

const AGENTS: AgentName[] = ['orchestrator', 'triage', 'retrieval', 'reviewer'];
let h: Harness;
let stubs: Record<AgentName, StubEgress>;
const telemetry = createMessagingTelemetry();

beforeAll(async () => {
  h = await createHarness();
  const ingestPool = new Pool({ connectionString: process.env.TEST_DOCUMENT_INGEST_URL, max: 2 });
  try { await ingestSyntheticCatalog(ingestPool); } finally { await ingestPool.end(); }
  stubs = {
    orchestrator: await startStubEgress('orchestrator', h.pools),
    triage: await startStubEgress('triage', h.pools),
    retrieval: await startStubEgress('retrieval', h.pools),
    reviewer: await startStubEgress('reviewer', h.pools),
  };
});
afterAll(async () => {
  for (const s of Object.values(stubs ?? {})) await s.close();
  if (h) await closeHarness(h);
});

const member = async (subject: string, tenant: string) => h.adminPool.query(
  `INSERT INTO aegis.memberships (issuer, subject, tenant_id, role) VALUES ($1, $2, $3, 'reader') ON CONFLICT DO NOTHING`, [TEST_ISSUER, subject, tenant]);
const count = async (sql: string, values: unknown[] = []) => Number((await h.adminPool.query<{ n: string }>(sql, values)).rows[0].n);

/** Runs every agent's dispatcher, each through its own role, until no message is pending. Bounded. */
async function drain(): Promise<void> {
  for (let round = 0; round < 40; round += 1) {
    for (const agent of AGENTS) {
      await dispatchOnce({ pool: h.pools[agent], agentId: agent, instance: `${agent}-it`, egressUrl: stubs[agent].url, leaseSeconds: 30,
        batchSize: 20, deliveryTimeoutMs: 10000, telemetry });
    }
    if (await count(`SELECT count(*)::text AS n FROM aegis.agent_outbox WHERE status IN ('pending', 'leased')`) === 0) return;
  }
  throw new Error('messages still pending after bounded drain');
}

describe('investigation end to end (real PostgreSQL, real corpus)', () => {
  it('answers a question from the authorised corpus: triage, retrieval, review, cited final result', async () => {
    const started = await startInvestigation(h, { tenantId: NORTH, question: QUESTION });
    await drain();
    const exec = await h.adminPool.query<{ status: string; workflow_stage: string; steps_taken: number; delegations_issued: number }>(
      'SELECT status, workflow_stage, steps_taken, delegations_issued FROM aegis.agent_executions WHERE execution_id = $1', [started.executionId]);
    expect(exec.rows[0]).toEqual({ status: 'succeeded', workflow_stage: 'completed', steps_taken: 6, delegations_issued: 3 });
    const result = await h.adminPool.query<{ verdict: string; answer: string; citations: Array<{ ref: string }>; reviewer_decision: string }>(
      'SELECT verdict, answer, citations, reviewer_decision FROM aegis.investigation_results WHERE execution_id = $1', [started.executionId]);
    expect(result.rows[0].verdict).toBe('answered');
    expect(result.rows[0].reviewer_decision).toBe('approve');
    expect(result.rows[0].citations.length).toBeGreaterThanOrEqual(1);
    expect(result.rows[0].citations.every((c) => c.ref.startsWith('SYNTHETIC-NORTH-'))).toBe(true);
    expect(result.rows[0].answer.length).toBeGreaterThan(20);
    expect(await count(`SELECT count(*)::text AS n FROM aegis.agent_outbox WHERE execution_id = $1 AND status <> 'delivered'`, [started.executionId])).toBe(0);
    const view = await readInvestigation(((t, op) => withMessagingContext(h.pools.gateway, { tenantId: t }, op as never)) as never,
      readerPrincipal(), { tenantId: NORTH, executionId: started.executionId });
    expect(view.result?.verdict).toBe('answered');
    expect(view.status).toBe('succeeded');
  });

  it('a question with no document intent is answered as out of scope without any retrieval', async () => {
    const started = await startInvestigation(h, { tenantId: NORTH, question: 'What is the weather in Paris today?' });
    await drain();
    const result = await h.adminPool.query<{ verdict: string }>('SELECT verdict FROM aegis.investigation_results WHERE execution_id = $1', [started.executionId]);
    expect(result.rows[0].verdict).toBe('insufficient_evidence');
    expect(await count(`SELECT count(*)::text AS n FROM aegis.agent_outbox WHERE execution_id = $1 AND destination_agent = 'retrieval'`, [started.executionId])).toBe(0);
  });

  it('when the corpus has no matching evidence the investigation reports insufficient evidence, not an answer', async () => {
    const started = await startInvestigation(h, { tenantId: NORTH, question: 'Which document describes quantum spaceship maintenance?' });
    await drain();
    const result = await h.adminPool.query<{ verdict: string; answer: string | null; reviewer_decision: string }>(
      'SELECT verdict, answer, reviewer_decision FROM aegis.investigation_results WHERE execution_id = $1', [started.executionId]);
    expect(result.rows[0]).toEqual({ verdict: 'insufficient_evidence', answer: null, reviewer_decision: 'not_reviewed' });
    expect(await count(`SELECT count(*)::text AS n FROM aegis.agent_outbox WHERE execution_id = $1 AND destination_agent = 'reviewer'`, [started.executionId])).toBe(0);
  });

  it('retrieval is tenant-isolated: the south tenant cannot receive the north procedure', async () => {
    const started = await startInvestigation(h, { tenantId: SOUTH, question: QUESTION });
    await drain();
    const evidence = await h.adminPool.query<{ content: string }>(
      `SELECT 1 AS content FROM aegis.investigation_results WHERE execution_id = $1 AND citations::text LIKE '%SYNTHETIC-NORTH-%'`, [started.executionId]);
    expect(evidence.rows).toHaveLength(0);
    const result = await h.adminPool.query<{ verdict: string }>('SELECT verdict FROM aegis.investigation_results WHERE execution_id = $1', [started.executionId]);
    expect(result.rows[0].verdict).toBe('insufficient_evidence');
  });

  it('cancellation requested before intake is applied by the claim, and nothing is dispatched', async () => {
    const run = (t: string, op: never) => withMessagingContext(h.pools.gateway, { tenantId: t }, op);
    await member('cancel-user', NORTH);
    await member('cancel-user', NORTH);
    await member('cancel-user', NORTH);
    const submitted = await submitInvestigation(run as never, readerPrincipal('cancel-user'), { tenantId: NORTH, idempotencyKey: randomUUID(), question: QUESTION });
    const cancelled = await requestCancellation(run as never, readerPrincipal('cancel-user'), { tenantId: NORTH, executionId: submitted.executionId, reason: 'user_request' });
    expect(cancelled.accepted).toBe(true);
    const outcome = await withMessagingContext(h.pools.orchestrator, { tenantId: NORTH }, (c) => startInvestigationInTx(c, {}, {
      tenantId: NORTH, executionId: submitted.executionId, orchestrator: { spiffeId: SPIFFE.orchestrator, instance: 'test' } }));
    expect(outcome).toBe('cancelled');
    const row = await h.adminPool.query<{ status: string; workflow_stage: string }>('SELECT status, workflow_stage FROM aegis.agent_executions WHERE execution_id = $1', [submitted.executionId]);
    expect(row.rows[0]).toEqual({ status: 'cancelled', workflow_stage: 'cancelled' });
    expect(await count('SELECT count(*)::text AS n FROM aegis.agent_outbox WHERE execution_id = $1', [submitted.executionId])).toBe(0);
  });

  it('a result that arrives after cancellation is consumed and discarded: no further step is dispatched', async () => {
    const started = await startInvestigation(h, { tenantId: NORTH, question: QUESTION });
    const run = (t: string, op: never) => withMessagingContext(h.pools.gateway, { tenantId: t }, op);
    // The triage request is in flight. Cancel while it is processed.
    await requestCancellation(run as never, readerPrincipal(), { tenantId: NORTH, executionId: started.executionId, reason: 'user_request' });
    await drain();
    const row = await h.adminPool.query<{ status: string; workflow_stage: string }>('SELECT status, workflow_stage FROM aegis.agent_executions WHERE execution_id = $1', [started.executionId]);
    expect(row.rows[0]).toEqual({ status: 'cancelled', workflow_stage: 'cancelled' });
    expect(await count(`SELECT count(*)::text AS n FROM aegis.agent_outbox WHERE execution_id = $1 AND destination_agent = 'retrieval'`, [started.executionId])).toBe(0);
    expect(await count(`SELECT count(*)::text AS n FROM aegis.agent_grants WHERE execution_id = $1 AND status = 'open'`, [started.executionId])).toBe(0);
  });
});

describe('gateway: authenticated origin, membership, idempotency and principal binding', () => {
  const run = (t: string, op: never) => withMessagingContext(h.pools.gateway, { tenantId: t }, op);
  it('refuses a principal without the read scope, a non-member, and a foreign tenant', async () => {
    await expect(submitInvestigation(run as never, { issuer: TEST_ISSUER, subject: 'test-reader', scopes: new Set() },
      { tenantId: NORTH, idempotencyKey: randomUUID(), question: QUESTION })).rejects.toMatchObject({ code: 'forbidden' });
    await expect(submitInvestigation(run as never, readerPrincipal('stranger'), { tenantId: NORTH, idempotencyKey: randomUUID(), question: QUESTION }))
      .rejects.toMatchObject({ code: 'forbidden' });
    await h.adminPool.query(`DELETE FROM aegis.memberships WHERE subject = 'reader-only-north'`);
    await h.adminPool.query(`INSERT INTO aegis.memberships (issuer, subject, tenant_id, role) VALUES ($1, 'reader-only-north', $2, 'reader') ON CONFLICT DO NOTHING`, [TEST_ISSUER, NORTH]);
    await expect(submitInvestigation(run as never, readerPrincipal('reader-only-north'), { tenantId: SOUTH, idempotencyKey: randomUUID(), question: QUESTION }))
      .rejects.toMatchObject({ code: 'forbidden' });
  });

  it('an idempotent retry returns the same execution; another principal cannot reuse the key', async () => {
    const key = randomUUID();
    await member('retry-user', NORTH);
    const first = await submitInvestigation(run as never, readerPrincipal('retry-user'), { tenantId: NORTH, idempotencyKey: key, question: QUESTION });
    const again = await submitInvestigation(run as never, readerPrincipal('retry-user'), { tenantId: NORTH, idempotencyKey: key, question: QUESTION });
    expect(again).toEqual({ executionId: first.executionId, created: false });
    await h.adminPool.query(`INSERT INTO aegis.memberships (issuer, subject, tenant_id, role) VALUES ($1, 'other-user', $2, 'reader') ON CONFLICT DO NOTHING`, [TEST_ISSUER, NORTH]);
    await expect(submitInvestigation(run as never, readerPrincipal('other-user'), { tenantId: NORTH, idempotencyKey: key, question: QUESTION }))
      .rejects.toMatchObject({ code: 'idempotency_conflict' });
  });

  it('another principal cannot read or cancel an execution, and receives the same answer as for a missing one', async () => {
    await member('owner-user', NORTH);
    await member('other-user', NORTH);
    const mine = await submitInvestigation(run as never, readerPrincipal('owner-user'), { tenantId: NORTH, idempotencyKey: randomUUID(), question: QUESTION });
    await expect(readInvestigation(run as never, readerPrincipal('other-user'), { tenantId: NORTH, executionId: mine.executionId }))
      .rejects.toMatchObject({ code: 'not_found' });
    await expect(requestCancellation(run as never, readerPrincipal('other-user'), { tenantId: NORTH, executionId: mine.executionId, reason: 'user_request' }))
      .rejects.toMatchObject({ code: 'not_found' });
  });

  it('refuses control characters and oversized questions before any database write', () => {
    expect(() => validateQuestion('ok\u0000')).toThrow(GatewayError);
    expect(() => validateQuestion('x'.repeat(1001))).toThrow(GatewayError);
    expect(principalDigest('a', 'b')).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('a compromised triage runtime cannot act as another agent or as the orchestrator', () => {
  it('cannot dispatch as retrieval, consume retrieval grants, claim leases, or change protected rows', async () => {
    const started = await startInvestigation(h, { tenantId: NORTH, question: QUESTION });
    const triage = h.pools.triage;
    const denied = async (sql: string, values: unknown[] = []) => {
      try { const r = await triage.query(sql, values); return { rows: r.rowCount ?? 0 }; } catch (error) {
        return { error: (error as { code?: string }).code ?? 'error' };
      }
    };
    // Every operation below must be refused: by an error, or by affecting no rows. Either way nothing changes.
    const refused = (value: { error?: string; rows?: number }) => value.error !== undefined || value.rows === 0;
    // Forged sender: an outbox row claiming to be from retrieval.
    expect(refused(await denied(`INSERT INTO aegis.agent_outbox (tenant_id, execution_id, sender_agent, destination_agent, kind, envelope, payload, payload_digest)
      VALUES ($1, $2, 'retrieval', 'orchestrator', 'result', '{}'::jsonb, '{}'::jsonb, $3)`, [NORTH, started.executionId, 'a'.repeat(64)]))).toBe(true);
    // Dispatch as the orchestrator: the orchestrator's pending request is invisible to triage (zero rows, not an error).
    expect(refused(await denied(`UPDATE aegis.agent_outbox SET status = 'delivered', delivered_at = clock_timestamp() WHERE sender_agent = 'orchestrator' AND execution_id = $1`, [started.executionId])))
      .toBe(true);
    // A session setting does not change the identity: setting another agent's id still resolves to triage.
    await triage.query("SELECT set_config('aegis.agent_id', 'retrieval', false)");
    expect((await triage.query<{ agent: string }>('SELECT aegis.current_agent() AS agent')).rows[0].agent).toBe('triage');
    expect(await denied(`SELECT 1 FROM aegis.agent_outbox WHERE sender_agent = 'orchestrator'`)).toEqual({ rows: 0 });
    // Consume a grant addressed to retrieval, or any grant at all, as triage.
    expect(refused(await denied(`UPDATE aegis.agent_grants SET status = 'consumed', consumed_at = clock_timestamp(), consumed_by_agent = 'triage', consumed_by_fencing_token = 1 WHERE execution_id = $1 AND to_agent = 'retrieval'`, [started.executionId]))).toBe(true);
    // Grant itself elevated scopes or new authority: no insert right on delegations or grants.
    expect(refused(await denied(`INSERT INTO aegis.agent_delegations (tenant_id, execution_id, seq, parent_seq, depth, from_agent, to_agent, effective_scopes, chain_digest, fencing_token)
      VALUES ($1, $2, 9, NULL, 1, 'triage', 'retrieval', ARRAY['case:read'], $3, 1)`, [NORTH, started.executionId, 'b'.repeat(64)]))).toBe(true);
    // Modify protected registrations.
    expect(refused(await denied(`UPDATE aegis.agent_registrations SET registered_scopes = ARRAY['case:read','case:write'] WHERE agent_id = 'triage'`))).toBe(true);
    // Move the execution: stage and status are the orchestrator's.
    expect(refused(await denied(`UPDATE aegis.agent_executions SET workflow_stage = 'completed', status = 'succeeded' WHERE execution_id = $1`, [started.executionId]))).toBe(true);
    // Forge the final result.
    expect(refused(await denied(`INSERT INTO aegis.investigation_results (execution_id, tenant_id, verdict, answer, citations, reviewer_decision)
      VALUES ($1, $2, 'answered', 'forged', '[]'::jsonb, 'approve')`, [started.executionId, NORTH]))).toBe(true);
    // Operator actions.
    expect(refused(await denied(`UPDATE aegis.agent_outbox SET status = 'pending', dead_at = NULL, dead_reason = NULL WHERE status = 'dead'`))).toBe(true);
    expect(refused(await denied(`DELETE FROM aegis.agent_outbox WHERE status = 'delivered'`))).toBe(true);
    // Claim a lease as an agent other than the orchestrator: the P4 claim refuses (registration is not this session's identity).
    const claimAsTriage = await withMessagingContext(triage, { tenantId: NORTH }, async (client) => {
      const r = await client.query<{ n: string }>(`SELECT count(*)::text AS n FROM aegis.agent_registrations WHERE spiffe_id = $1 AND agent_id = aegis.current_agent()`, [SPIFFE.orchestrator]);
      return r.rows[0].n;
    });
    expect(claimAsTriage).toBe('0');
    // The orchestrator's state is untouched by all of the above.
    const state = await h.adminPool.query<{ workflow_stage: string; status: string }>('SELECT workflow_stage, status FROM aegis.agent_executions WHERE execution_id = $1', [started.executionId]);
    expect(state.rows[0].workflow_stage).toBe('triage_requested');
  });

  it('a reply is possible only after the agent consumed a verified request in the same execution', async () => {
    const started = await startInvestigation(h, { tenantId: NORTH, question: QUESTION });
    // Retrieval has no consumed request for this execution, so it cannot insert a reply for it.
    const retrieval = h.pools.retrieval;
    await expect(retrieval.query(`INSERT INTO aegis.agent_outbox (tenant_id, execution_id, sender_agent, destination_agent, kind, envelope, payload, payload_digest)
      VALUES ($1, $2, 'retrieval', 'orchestrator', 'result', '{}'::jsonb, '{}'::jsonb, $3)`, [NORTH, started.executionId, 'c'.repeat(64)]))
      .rejects.toThrow();
  });
});

describe('replay and duplicate delivery of investigation messages', () => {
  it('a repeated result delivery to the orchestrator is a duplicate and advances nothing', async () => {
    const started = await startInvestigation(h, { tenantId: NORTH, question: QUESTION });
    const sent = await dispatchOnce({ pool: h.pools.orchestrator, agentId: 'orchestrator', instance: 'dup', egressUrl: stubs.orchestrator.url,
      leaseSeconds: 30, batchSize: 5, deliveryTimeoutMs: 10000, telemetry });
    expect(sent.delivered).toBeGreaterThanOrEqual(1);
    const triageSent = await dispatchOnce({ pool: h.pools.triage, agentId: 'triage', instance: 'dup', egressUrl: stubs.triage.url,
      leaseSeconds: 30, batchSize: 5, deliveryTimeoutMs: 10000, telemetry });
    expect(triageSent.delivered).toBeGreaterThanOrEqual(1);
    const planResult = await h.adminPool.query<{ message_id: string }>(`SELECT message_id FROM aegis.agent_outbox WHERE execution_id = $1 AND sender_agent = 'triage'`, [started.executionId]);
    const body = await wireOf(h, planResult.rows[0].message_id);
    const again = await receiveMessage(h.pools.orchestrator, {}, { receiver: 'orchestrator', peerSpiffeId: SPIFFE.triage, messageId: planResult.rows[0].message_id,
      body, orchestrator: { spiffeId: SPIFFE.orchestrator, instance: 'test' } });
    expect(again).toMatchObject({ httpStatus: 200, status: 'duplicate' });
    const stage = await h.adminPool.query<{ workflow_stage: string }>('SELECT workflow_stage FROM aegis.agent_executions WHERE execution_id = $1', [started.executionId]);
    expect(['retrieval_requested', 'evidence_received', 'review_requested']).toContain(stage.rows[0].workflow_stage);
    await drain();
  });

  it('a result from a sender that is not the expected stage owner is refused', async () => {
    const started = await startInvestigation(h, { tenantId: NORTH, question: QUESTION });
    const body = await wireOf(h, started.requestMessageId);
    // The orchestrator's own request, presented to the orchestrator as if it were a result, is refused for its kind.
    const refusal = await receiveMessage(h.pools.orchestrator, {}, { receiver: 'orchestrator', peerSpiffeId: SPIFFE.triage,
      messageId: started.requestMessageId, body, orchestrator: { spiffeId: SPIFFE.orchestrator, instance: 'test' } });
    expect(refusal.httpStatus).toBe(409);
    await drain();
  });
});

describe('the stage machine is enforced by the database', () => {
  it('refuses a transition that skips review, even from the orchestrator role', async () => {
    const started = await startInvestigation(h, { tenantId: NORTH, question: QUESTION });
    await expect(withMessagingContext(h.pools.orchestrator, { tenantId: NORTH }, (c) => c.query(
      `UPDATE aegis.agent_executions SET workflow_stage = 'completed' WHERE execution_id = $1`, [started.executionId])))
      .rejects.toThrow(/transition/);
    await drain();
  });
});

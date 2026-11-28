import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { ingestSyntheticCatalog } from '../../documents/ingestion.js';
import { createDatabasePool } from '../../storage/database.js';
import { createAgentExecutionStore, joinTransaction, type Fence } from '../persistence/execution-store.js';
import { submitInvestigation, requestCancellation } from '../../investigation/gateway.js';
import { dispatchOnce } from './dispatcher.js';
import { reconcileCancellations } from './cancellation.js';
import { withMessagingContext } from './context.js';
import { receiveMessage } from './inbox.js';
import type { TenantQueryable } from '../../security/tool-approval-store.js';
import { createMessagingTelemetry } from './telemetry.js';
import { createHarness, closeHarness, readerPrincipal, roleUrl, startInvestigation, startStubEgress, wireOf, SPIFFE, NORTH, SOUTH, QUESTION,
  type AgentName, type Harness, type StubEgress } from './testing/support.js';

// Orchestrator-owned cancellation on real PostgreSQL, through the real database roles. The reconciliation under test is the same function
// the orchestrator's runtime loop runs. Races are ordered explicitly by running one transaction to a known point before the other; no
// test depends on sleeps.

const AGENTS: AgentName[] = ['orchestrator', 'triage', 'retrieval', 'reviewer'];
const telemetry = createMessagingTelemetry();
const hooks = {};
let h: Harness;
let stubs: Record<AgentName, StubEgress>;

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

const run = (tenant: string, op: never) => withMessagingContext(h.pools.gateway, { tenantId: tenant }, op);
/** Runs SQL as one participant's own database role, bound to the tenant, exactly as the runtime does. */
const asAgent = <T>(agent: AgentName, tenant: string, op: (client: TenantQueryable) => Promise<T>): Promise<T> =>
  withMessagingContext(h.pools[agent], { tenantId: tenant }, op as never) as Promise<T>;
const count = async (sql: string, values: unknown[] = []) => Number((await h.adminPool.query<{ n: string }>(sql, values)).rows[0].n);
const state = async (executionId: string) => (await h.adminPool.query<{ status: string; workflow_stage: string; cancel_requested: boolean;
  lease_agent_id: string | null; fencing_token: string }>(
  'SELECT status, workflow_stage, cancel_requested, lease_agent_id, fencing_token::text FROM aegis.agent_executions WHERE execution_id = $1',
  [executionId])).rows[0];
const reconcile = (limit?: number) => reconcileCancellations(h.pools.orchestrator, hooks, { instance: 'reconciler-test', limit });
const cancel = (tenant: string, executionId: string) => requestCancellation(run as never, readerPrincipal(), { tenantId: tenant, executionId,
  reason: 'user_request' });
const dispatch = (agent: AgentName) => dispatchOnce({ pool: h.pools[agent], agentId: agent, instance: `${agent}-cr`,
  egressUrl: stubs[agent].url, leaseSeconds: 30, batchSize: 20, deliveryTimeoutMs: 10000, telemetry });

/** Claims the execution as the orchestrator and returns the fence. The lease stays live until the returned holder releases or it expires. */
async function holdLease(tenant: string, executionId: string, instance: string): Promise<Fence> {
  return withMessagingContext(h.pools.orchestrator, { tenantId: tenant }, async (client) => {
    const store = createAgentExecutionStore(joinTransaction(client, tenant), hooks);
    const claim = await store.claim({ tenantId: tenant, executionId, spiffeId: SPIFFE.orchestrator, instance, leaseSeconds: 120 });
    if (!claim.ok) throw new Error(`claim refused: ${claim.reason}`);
    return { tenantId: tenant, executionId, agentId: claim.value.agentId, instance, fencingToken: claim.value.fencingToken };
  });
}

/** A fenced write attempted by a stale holder. */
const staleRelease = (tenant: string, fence: Fence) => withMessagingContext(h.pools.orchestrator, { tenantId: tenant }, (client) =>
  createAgentExecutionStore(joinTransaction(client, tenant), hooks).release(fence, 'pending', 'late_write'));

/** Runs dispatch rounds for the given agents until the condition holds. Bounded. */
async function pumpUntil(condition: () => Promise<boolean>, agents: AgentName[]): Promise<void> {
  for (let round = 0; round < 40; round += 1) {
    if (await condition()) return;
    for (const agent of agents) await dispatch(agent);
  }
  throw new Error('condition not reached within the bounded pump');
}

describe('A. cancellation before any work starts', () => {
  it('is finalised by reconciliation with no message and no grant, and a second cycle changes nothing', async () => {
    const submitted = await submitInvestigation(run as never, readerPrincipal(), { tenantId: NORTH, idempotencyKey: randomUUID(), question: QUESTION });
    expect((await cancel(NORTH, submitted.executionId)).accepted).toBe(true);
    expect((await state(submitted.executionId)).status).toBe('pending');
    expect(await reconcile()).toMatchObject({ applied: 1 });
    expect(await state(submitted.executionId)).toMatchObject({ status: 'cancelled', workflow_stage: 'cancelled' });
    expect(await count(`SELECT count(*)::text AS n FROM aegis.agent_outbox WHERE execution_id = $1`, [submitted.executionId])).toBe(0);
    expect(await count(`SELECT count(*)::text AS n FROM aegis.agent_grants WHERE execution_id = $1`, [submitted.executionId])).toBe(0);
    expect(await reconcile()).toMatchObject({ applied: 0 });
  });
});

describe('B. cancellation while an orchestrator lease is live', () => {
  it('finalises the execution, clears the lease, and fences the holder out', async () => {
    const started = await startInvestigation(h, { tenantId: NORTH });
    const fence = await holdLease(NORTH, started.executionId, 'holder-b');
    expect((await state(started.executionId)).lease_agent_id).toBe('orchestrator');
    expect((await cancel(NORTH, started.executionId)).accepted).toBe(true);
    // The request is recorded; the live lease is not yet finalised by the gateway.
    expect(await state(started.executionId)).toMatchObject({ cancel_requested: true, status: 'running' });
    expect(await reconcile()).toMatchObject({ applied: 1 });
    expect(await state(started.executionId)).toMatchObject({ status: 'cancelled', lease_agent_id: null });
    expect(await staleRelease(NORTH, fence)).toMatchObject({ ok: false });
  });
});

describe('C. cancellation after triage has received its request', () => {
  it('refuses the triage result and leaves no retrieval step', async () => {
    const started = await startInvestigation(h, { tenantId: NORTH });
    await dispatch('orchestrator'); // delivers the triage request
    expect(await count(`SELECT count(*)::text AS n FROM aegis.agent_inbox WHERE receiver_agent = 'triage' AND execution_id = $1
      AND outcome = 'processed'`, [started.executionId])).toBe(1);
    await cancel(NORTH, started.executionId);
    expect(await reconcile()).toMatchObject({ applied: 1 });
    expect(await count(`SELECT count(*)::text AS n FROM aegis.agent_grants WHERE execution_id = $1 AND status = 'open'`, [started.executionId])).toBe(0);
    await dispatch('triage'); // delivers the triage result to the orchestrator, which refuses it
    expect(await count(`SELECT count(*)::text AS n FROM aegis.agent_outbox WHERE execution_id = $1 AND destination_agent = 'retrieval'`,
      [started.executionId])).toBe(0);
    expect(await state(started.executionId)).toMatchObject({ status: 'cancelled', workflow_stage: 'cancelled' });
  });
});

describe('D. cancellation requested before triage consumes its grant', () => {
  it('refuses the request at triage and leaves the grant unconsumed and revoked', async () => {
    const started = await startInvestigation(h, { tenantId: NORTH });
    await cancel(NORTH, started.executionId);
    expect(await reconcile()).toMatchObject({ applied: 1 });
    await dispatch('orchestrator'); // the request reaches triage after cancellation
    expect(await count(`SELECT count(*)::text AS n FROM aegis.agent_inbox WHERE receiver_agent = 'triage' AND message_id = $1
      AND outcome = 'refused'`, [started.requestMessageId])).toBe(1);
    expect(await count(`SELECT count(*)::text AS n FROM aegis.agent_grants WHERE execution_id = $1 AND kind = 'request'
      AND status = 'consumed'`, [started.executionId])).toBe(0);
    expect(await count(`SELECT count(*)::text AS n FROM aegis.agent_grants WHERE execution_id = $1 AND kind = 'request'
      AND status = 'revoked'`, [started.executionId])).toBe(1);
    expect(await count(`SELECT count(*)::text AS n FROM aegis.agent_outbox WHERE message_id = $1 AND status = 'dead'`,
      [started.requestMessageId])).toBe(1);
  });
});

describe('E. bounded reconciliation', () => {
  it('moves every requested cancellation to terminal status within one bounded cycle', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 3; i += 1) ids.push((await startInvestigation(h, { tenantId: NORTH })).executionId);
    ids.push((await startInvestigation(h, { tenantId: SOUTH })).executionId);
    for (const id of ids) await cancel(id === ids[3] ? SOUTH : NORTH, id);
    const summary = await reconcile(50);
    expect(summary.candidates).toBeLessThanOrEqual(50);
    for (const id of ids) expect((await state(id)).status).toBe('cancelled');
  });
});

describe('F. no participant can update execution status, revoke grants, or discover cancellations', () => {
  it('is refused by the database for every participant role', async () => {
    const started = await startInvestigation(h, { tenantId: NORTH });
    for (const agent of ['triage', 'retrieval', 'reviewer'] as const) {
      await expect(asAgent(agent, NORTH, (c) => c.query(`UPDATE aegis.agent_executions SET status = 'succeeded' WHERE execution_id = $1`,
        [started.executionId]))).rejects.toThrow(/permission denied/);
    }
    await asAgent('triage', NORTH, (c) => c.query(`UPDATE aegis.agent_grants SET status = 'revoked', revoked_at = clock_timestamp()
      WHERE execution_id = $1`, [started.executionId])).catch(() => undefined);
    expect(await count(`SELECT count(*)::text AS n FROM aegis.agent_grants WHERE execution_id = $1 AND status = 'open'`, [started.executionId])).toBeGreaterThan(0);
    await expect(asAgent('triage', NORTH, (c) => c.query('SELECT * FROM aegis.orchestrator_due_cancellations(10)', [])))
      .rejects.toThrow(/permission denied/);
    expect((await state(started.executionId)).status).toBe('pending');
  });
});

describe('G. open grants are revoked and no request grant is consumed after cancellation', () => {
  it('leaves no open grant and refuses a later consumption attempt', async () => {
    const started = await startInvestigation(h, { tenantId: NORTH });
    await cancel(NORTH, started.executionId);
    await reconcile();
    expect(await count(`SELECT count(*)::text AS n FROM aegis.agent_grants WHERE execution_id = $1 AND status = 'open'`, [started.executionId])).toBe(0);
    const outcome = await asAgent('triage', NORTH, (c) => c.query(`UPDATE aegis.agent_grants SET status = 'consumed', consumed_at = clock_timestamp(),
      consumed_by_agent = 'triage' WHERE execution_id = $1 AND kind = 'request'`, [started.executionId]).then((r) => String(r.rowCount)))
      .catch((error: Error) => error.message);
    expect(outcome).toMatch(/^0$|cannot be consumed|permission denied|row-level security/);
    expect(await count(`SELECT count(*)::text AS n FROM aegis.agent_grants WHERE execution_id = $1 AND status = 'consumed'`, [started.executionId])).toBe(0);
  });
});

describe('H. an expired or stale fencing token cannot continue execution', () => {
  it('refuses a fenced write from a holder whose token was superseded by reconciliation', async () => {
    const started = await startInvestigation(h, { tenantId: NORTH });
    const fence = await holdLease(NORTH, started.executionId, 'holder-h');
    await cancel(NORTH, started.executionId);
    await reconcile();
    const before = Number((await state(started.executionId)).fencing_token);
    expect(before).toBeGreaterThan(fence.fencingToken);
    expect(await staleRelease(NORTH, fence)).toMatchObject({ ok: false });
    expect((await state(started.executionId)).status).toBe('cancelled');
  });
});

describe('I. a duplicate delivery cannot restart cancelled work', () => {
  it('returns the stored outcome for the repeated request and starts nothing', async () => {
    const started = await startInvestigation(h, { tenantId: NORTH });
    await dispatch('orchestrator'); // the request is processed by triage once
    await cancel(NORTH, started.executionId);
    await reconcile();
    const outboxBefore = await count(`SELECT count(*)::text AS n FROM aegis.agent_outbox WHERE execution_id = $1`, [started.executionId]);
    const body = await wireOf(h, started.requestMessageId);
    const again = await receiveMessage(h.pools.triage, hooks, { receiver: 'triage', peerSpiffeId: SPIFFE.orchestrator,
      messageId: started.requestMessageId, body });
    expect(again.status).toBe('duplicate');
    expect(await count(`SELECT count(*)::text AS n FROM aegis.agent_outbox WHERE execution_id = $1`, [started.executionId])).toBe(outboxBefore);
    expect((await state(started.executionId)).status).toBe('cancelled');
  });
});

describe('J. a result racing with cancellation', () => {
  it('cannot produce an approved answer once cancellation wins the row-lock ordering', async () => {
    const started = await startInvestigation(h, { tenantId: NORTH });
    // Run the workflow until the reviewer has produced its result but the orchestrator has not received it.
    await pumpUntil(async () => await count(`SELECT count(*)::text AS n FROM aegis.agent_outbox WHERE execution_id = $1
      AND sender_agent = 'reviewer' AND status IN ('pending', 'leased')`, [started.executionId]) > 0, ['orchestrator', 'triage', 'retrieval']);
    await cancel(NORTH, started.executionId);
    expect(await reconcile()).toMatchObject({ applied: 1 });
    await dispatch('reviewer'); // the reviewer's result arrives after cancellation
    expect(await count(`SELECT count(*)::text AS n FROM aegis.investigation_results WHERE execution_id = $1 AND verdict = 'answered'`,
      [started.executionId])).toBe(0);
    expect(await state(started.executionId)).toMatchObject({ status: 'cancelled', workflow_stage: 'cancelled' });
  }, 60000);
});

describe('K. repeated reconciliation is idempotent', () => {
  it('writes exactly one cancellation event', async () => {
    const started = await startInvestigation(h, { tenantId: NORTH });
    await cancel(NORTH, started.executionId);
    expect(await reconcile()).toMatchObject({ applied: 1 });
    expect(await reconcile()).toMatchObject({ applied: 0 });
    expect(await reconcile()).toMatchObject({ applied: 0 });
    expect(await count(`SELECT count(*)::text AS n FROM aegis.agent_execution_events WHERE execution_id = $1 AND event_type = 'cancelled'`,
      [started.executionId])).toBe(1);
  });
});

describe('L. cancellation resumes after orchestrator recovery', () => {
  it('a restarted orchestrator finalises a request recorded before the crash', async () => {
    const started = await startInvestigation(h, { tenantId: NORTH });
    const fence = await holdLease(NORTH, started.executionId, 'crashed-orchestrator');
    await cancel(NORTH, started.executionId);
    // The crashed process never releases its lease. A new process starts with a fresh pool under the same role.
    const restarted = createDatabasePool(roleUrl('orchestrator'), 2);
    try {
      expect(await reconcileCancellations(restarted, hooks, { instance: 'restarted-orchestrator' })).toMatchObject({ applied: 1 });
    } finally { await restarted.end(); }
    expect(await state(started.executionId)).toMatchObject({ status: 'cancelled', lease_agent_id: null });
    expect(await staleRelease(NORTH, fence)).toMatchObject({ ok: false });
  });
});

describe('M. North and South tenant isolation', () => {
  it('reconciles only the requesting tenant and refuses cross-tenant finalisation', async () => {
    const north = await startInvestigation(h, { tenantId: NORTH });
    const south = await startInvestigation(h, { tenantId: SOUTH });
    await cancel(NORTH, north.executionId);
    await reconcile();
    expect((await state(north.executionId)).status).toBe('cancelled');
    expect(await state(south.executionId)).toMatchObject({ status: 'pending', cancel_requested: false });
    // A South-scoped participant cannot see a North execution.
    const visible = await asAgent('triage', SOUTH, (c) => c.query('SELECT 1 FROM aegis.agent_executions WHERE execution_id = $1', [north.executionId]));
    expect(visible.rows).toEqual([]);
    // The orchestrator cannot finalise a North execution while bound to South.
    const crossTenant = await withMessagingContext(h.pools.orchestrator, { tenantId: SOUTH }, (client) =>
      createAgentExecutionStore(joinTransaction(client, SOUTH), hooks).finaliseCancellation(SOUTH, north.executionId, 'cross-tenant'));
    expect(crossTenant).toMatchObject({ ok: false, reason: 'not_found' });
  });
});

describe('N. legitimate uncancelled investigations still complete', () => {
  it('runs triage, retrieval and the reviewer to a succeeded, completed execution', async () => {
    const started = await startInvestigation(h, { tenantId: NORTH });
    await pumpUntil(async () => await count(`SELECT count(*)::text AS n FROM aegis.agent_outbox WHERE execution_id = $1
      AND status IN ('pending', 'leased')`, [started.executionId]) === 0 && (await state(started.executionId)).status !== 'running',
    AGENTS);
    expect(await state(started.executionId)).toMatchObject({ status: 'succeeded', workflow_stage: 'completed' });
  }, 60000);
});

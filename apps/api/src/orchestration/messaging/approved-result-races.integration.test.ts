import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { ingestSyntheticCatalog } from '../../documents/ingestion.js';
import { requestCancellation } from '../../investigation/gateway.js';
import type { TenantQueryable } from '../../security/tool-approval-store.js';
import { dispatchOnce } from './dispatcher.js';
import { reconcileCancellations } from './cancellation.js';
import { receiveMessage, type ReceiveResult } from './inbox.js';
import { withMessagingContext } from './context.js';
import { createMessagingTelemetry } from './telemetry.js';
import { createHarness, closeHarness, readerPrincipal, startInvestigation, startStubEgress, wireOf, SPIFFE, NORTH, QUESTION, type AgentName,
  type Harness, type StubEgress, isolateCancellationBacklog } from './testing/support.js';

/*
 * Approved-result finalisation races (Phase A.2 item 9.2, completed in A.3). The reviewer's approval travels the production path: the
 * orchestrator dispatches each step through its real dispatcher and the stub egress, the reviewer receives and answers, and the
 * reviewer's result is then delivered to the orchestrator's production receive path. Ordering is controlled by gates at documented commit
 * boundaries; contention is observed by blocking backend PID, and cleanup settles every started operation, including on failure.
 */

const telemetry = createMessagingTelemetry();
const hooks = {};
let h: Harness;
let stubs: Record<AgentName, StubEgress>;
const openGates: Array<{ open: () => void }> = [];
const inFlight: Array<Promise<unknown>> = [];

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

/** Failure-path cleanup: open every gate, then settle every started operation within a bound. No test leaves work unresolved. */
// Fixture lifecycle: every test starts and ends with an empty cancellation backlog, so exact reconciliation counts are meaningful.
beforeEach(async () => { await isolateCancellationBacklog(h); });
afterEach(async () => {
  for (const gate of openGates.splice(0)) gate.open();
  await bounded(Promise.allSettled(inFlight.splice(0)), 'settle in-flight operations', 20000).catch(() => undefined);
  await isolateCancellationBacklog(h);
});
afterAll(async () => {
  for (const s of Object.values(stubs ?? {})) await s.close();
  if (h) await closeHarness(h);
});

function barrier() {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => { resolve = res; });
  const gate = { promise, open: () => resolve() };
  openGates.push(gate);
  return gate;
}
function signal<T = void>() {
  let fire!: (value: T) => void;
  const promise = new Promise<T>((resolve) => { fire = resolve; });
  return { promise, fire };
}
function bounded<T>(promise: Promise<T>, label: string, ms = 20000): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const limit = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`timed out: ${label}`)), ms); timer.unref(); });
  return Promise.race([promise, limit]).finally(() => clearTimeout(timer));
}
/** Registers an operation for cleanup. The rejection is observed at once; the caller still awaits the original promise. */
function track<T>(promise: Promise<T>): Promise<T> {
  promise.catch(() => undefined);
  inFlight.push(promise);
  return promise;
}
const delay = (ms: number): Promise<void> => new Promise((resolve) => { const t = setTimeout(resolve, ms); t.unref(); });
async function until(condition: () => Promise<boolean>, label: string, attempts = 400): Promise<void> {
  for (let i = 0; i < attempts; i += 1) {
    if (await condition()) return;
    await delay(25);
  }
  const snapshot = (await h.adminPool.query<{ pid: number; state: string; wait: string | null; blocked_by: string; query: string }>(
    `SELECT a.pid, a.state, a.wait_event_type AS wait, array_to_string(pg_blocking_pids(a.pid), ',') AS blocked_by, left(a.query, 90) AS query
       FROM pg_stat_activity a WHERE a.datname = current_database() AND a.pid <> pg_backend_pid() ORDER BY a.pid`, [])).rows
    .map((r) => `pid=${r.pid} state=${r.state} wait=${r.wait ?? '-'} blocked_by=[${r.blocked_by}] q=${JSON.stringify(r.query)}`).join('\n');
  throw new Error(`timed out waiting for: ${label}. Lock snapshot:\n${snapshot}`);
}
const blockedBy = async (blockerPid: number, pattern: string): Promise<boolean> => Number((await h.adminPool.query<{ n: string }>(
  `SELECT count(*)::text AS n FROM pg_stat_activity w WHERE w.datname = current_database() AND w.wait_event_type = 'Lock'
     AND w.query ILIKE $1 AND $2 = ANY(pg_blocking_pids(w.pid))`, [`%${pattern}%`, blockerPid])).rows[0].n) > 0;
const blockedByIdleTransaction = async (pattern: string): Promise<boolean> => Number((await h.adminPool.query<{ n: string }>(
  `SELECT count(*)::text AS n FROM pg_stat_activity w
    WHERE w.datname = current_database() AND w.wait_event_type = 'Lock' AND w.query ILIKE $1
      AND EXISTS (SELECT 1 FROM pg_stat_activity b WHERE b.pid = ANY(pg_blocking_pids(w.pid)) AND b.state = 'idle in transaction')`,
  [`%${pattern}%`])).rows[0].n) > 0;

const state = async (executionId: string) => (await h.adminPool.query<{ status: string; workflow_stage: string; cancel_requested: boolean;
  lease_agent_id: string | null; fencing_token: string }>(
  `SELECT status, workflow_stage, cancel_requested, lease_agent_id, fencing_token::text AS fencing_token
     FROM aegis.agent_executions WHERE execution_id = $1`, [executionId])).rows[0];
const events = async (executionId: string, eventType: string) => Number((await h.adminPool.query<{ n: string }>(
  'SELECT count(*)::text AS n FROM aegis.agent_execution_events WHERE execution_id = $1 AND event_type = $2', [executionId, eventType])).rows[0].n);
const openGrants = async (executionId: string) => Number((await h.adminPool.query<{ n: string }>(
  `SELECT count(*)::text AS n FROM aegis.agent_grants WHERE execution_id = $1 AND status = 'open'`, [executionId])).rows[0].n);
const results = async (executionId: string) => (await h.adminPool.query<{ verdict: string; answer: string | null; citations: Array<{ ref: string }>;
  reviewer_decision: string }>(
  'SELECT verdict, answer, citations, reviewer_decision FROM aegis.investigation_results WHERE execution_id = $1', [executionId])).rows;

const reconcile = () => reconcileCancellations(h.pools.orchestrator, hooks, { instance: 'approved-race', limit: 50, lockTimeoutMs: 15000 });

/**
 * Runs the production workflow until the reviewer's approval is a pending result in the reviewer's outbox. The reviewer's own dispatcher
 * is NOT run here, so the result is delivered to the orchestrator only by the test, through the production receive path.
 */
async function reachReviewerResult(executionId: string): Promise<string> {
  for (let round = 0; round < 40; round += 1) {
    for (const agent of ['orchestrator', 'triage', 'retrieval'] as AgentName[]) {
      await dispatchOnce({ pool: h.pools[agent], agentId: agent, instance: `${agent}-race`, egressUrl: stubs[agent].url, leaseSeconds: 30,
        batchSize: 20, deliveryTimeoutMs: 10000, telemetry });
    }
    const pending = await h.adminPool.query<{ message_id: string }>(
      `SELECT message_id FROM aegis.agent_outbox WHERE execution_id = $1 AND sender_agent = 'reviewer' AND destination_agent = 'orchestrator' AND status = 'pending'`,
      [executionId]);
    if (pending.rows[0]) return pending.rows[0].message_id;
  }
  throw new Error('the reviewer result was not reached');
}

/** The production gateway request, optionally paused after its flag write and before COMMIT (its row lock is held meanwhile). */
function gatewayRequest(executionId: string, pause?: { reached: (pid: number) => void; proceed: Promise<void> }) {
  const runner = (tenant: string, op: (client: TenantQueryable) => Promise<unknown>) =>
    withMessagingContext(h.pools.gateway, { tenantId: tenant }, async (client) => {
      const result = await op(client);
      if (pause) {
        pause.reached(Number((await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid', [])).rows[0].pid));
        await pause.proceed;
      }
      return result;
    });
  return requestCancellation(runner as never, readerPrincipal(), { tenantId: NORTH, executionId, reason: 'user_request' });
}

/** The production orchestrator receive path for the reviewer's result. */
const deliverReviewerResult = (messageId: string, body: Record<string, unknown>, options: { beforeCommit?: (label: string) => Promise<void> } = {}) =>
  receiveMessage(h.pools.orchestrator, options, { receiver: 'orchestrator', peerSpiffeId: SPIFFE.reviewer, messageId, body,
    orchestrator: { spiffeId: SPIFFE.orchestrator, instance: 'approved-race' } });

describe('9.2 approved-result finalisation races (reviewer result through the production receive path)', () => {
  it('12.1 cancellation wins: the approved result queues behind the held cancellation, is consumed without completing, and nothing persists', async () => {
    const started = await startInvestigation(h, { tenantId: NORTH, question: QUESTION });
    const messageId = await reachReviewerResult(started.executionId);
    const body = await wireOf(h, messageId);
    const before = await state(started.executionId);
    expect(before).toMatchObject({ workflow_stage: 'review_requested', cancel_requested: false, lease_agent_id: null });

    // The cancellation transaction holds the execution row lock and pauses before commit.
    const reached = signal<number>();
    const proceed = barrier();
    const cancelling = track(gatewayRequest(started.executionId, { reached: reached.fire, proceed: proceed.promise }));
    const gatewayPid = await bounded(reached.promise, 'cancellation holds the execution row lock');
    const delivering = track(deliverReviewerResult(messageId, body));
    await until(() => blockedBy(gatewayPid, 'aegis.agent_'), 'approved result queued behind the cancellation');
    proceed.open();
    expect(await bounded(cancelling, 'cancellation commit')).toMatchObject({ accepted: true, state: 'cancel_requested' });
    // The claim sees the committed request: it applies the cancellation and refuses. The result is consumed and recorded, not completed.
    const delivered = (await bounded(delivering, 'approved result delivery')) as ReceiveResult;
    expect(delivered.status).toBe('processed');

    const after = await state(started.executionId);
    expect(after).toMatchObject({ status: 'cancelled', workflow_stage: 'cancelled', cancel_requested: true, lease_agent_id: null });
    // The refused claim takes no lease and does not advance the fencing token.
    expect(after.fencing_token).toBe(before.fencing_token);
    expect(await results(started.executionId)).toEqual([]);
    expect(await openGrants(started.executionId)).toBe(0);
    expect(await events(started.executionId, 'cancelled')).toBe(1);
    expect(await events(started.executionId, 'cancel_requested')).toBe(1);
    expect(await count(`SELECT count(*)::text AS n FROM aegis.agent_execution_events WHERE execution_id = $1 AND reason = 'completed'`,
      [started.executionId])).toBe(0);

    // Duplicate and delayed delivery of the same reviewer result cannot revive the execution.
    const duplicate = await deliverReviewerResult(messageId, body);
    expect(duplicate.status).toBe('duplicate');
    expect((await reconcile()).candidates).toBe(0);
    expect(await state(started.executionId)).toMatchObject({ status: 'cancelled', workflow_stage: 'cancelled' });
    expect(await results(started.executionId)).toEqual([]);
    expect(await events(started.executionId, 'cancelled')).toBe(1);
  }, 120000);

  it('12.2 approved completion wins: the approved answer is persisted under the held lock, and the cancellation is then refused as terminal', async () => {
    const started = await startInvestigation(h, { tenantId: NORTH, question: QUESTION });
    const messageId = await reachReviewerResult(started.executionId);
    const body = await wireOf(h, messageId);

    // The approved completion holds the execution row lock after its result is persisted, and pauses before commit.
    const holding = signal();
    const commit = barrier();
    const delivering = track(deliverReviewerResult(messageId, body, {
      beforeCommit: async (label) => {
        if (label === 'release:accepted') { holding.fire(); await commit.promise; }
      },
    }));
    await bounded(holding.promise, 'approved completion holds the execution row lock before commit');
    const cancelling = track(gatewayRequest(started.executionId));
    await until(() => blockedByIdleTransaction('aegis.agent_'), 'cancellation queued behind the approved completion');
    commit.open();
    expect(await bounded(delivering, 'approved completion commit')).toMatchObject({ status: 'processed' });
    // The gateway observes the terminal execution and cannot overwrite it.
    expect(await bounded(cancelling, 'queued cancellation')).toEqual({ accepted: false, state: 'terminal' });

    expect(await state(started.executionId)).toMatchObject({ status: 'succeeded', workflow_stage: 'completed', cancel_requested: false,
      lease_agent_id: null });
    const persisted = await results(started.executionId);
    expect(persisted).toHaveLength(1);
    expect(persisted[0]).toMatchObject({ verdict: 'answered', reviewer_decision: 'approve' });
    expect(persisted[0].answer).not.toBeNull();
    expect(persisted[0].citations.length).toBeGreaterThanOrEqual(1);
    expect(persisted[0].citations.every((c) => c.ref.startsWith('SYNTHETIC-NORTH-'))).toBe(true);
    expect(await openGrants(started.executionId)).toBe(0);
    expect(await events(started.executionId, 'cancelled')).toBe(0);
    expect(await events(started.executionId, 'cancel_requested')).toBe(0);

    // Repeated cancellation and reconciliation leave the committed result and terminal state unchanged.
    expect(await bounded(gatewayRequest(started.executionId), 'repeated cancellation')).toEqual({ accepted: false, state: 'terminal' });
    expect((await reconcile()).candidates).toBe(0);
    expect(await results(started.executionId)).toEqual(persisted);
    expect(await state(started.executionId)).toMatchObject({ status: 'succeeded', workflow_stage: 'completed' });
  }, 120000);
});

async function count(sql: string, values: unknown[] = []): Promise<number> {
  return Number((await h.adminPool.query<{ n: string }>(sql, values)).rows[0].n);
}

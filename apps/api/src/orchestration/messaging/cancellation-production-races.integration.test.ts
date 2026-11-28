import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { requestCancellation } from '../../investigation/gateway.js';
import type { TenantQueryable } from '../../security/tool-approval-store.js';
import { reconcileCancellations } from './cancellation.js';
import { receiveMessage } from './inbox.js';
import { withMessagingContext } from './context.js';
import { createHarness, closeHarness, readerPrincipal, roleUrl, spawnMessagingWorker, startInvestigation, wireOf, SPIFFE, NORTH, type Harness } from './testing/support.js';

/*
 * Production-path races for cancellation (Phase A.2, items 9.1 and 9.3). Every request goes through the production functions: the
 * gateway's requestCancellation as the gateway login, the inbox's receiveMessage as the participant login (triage), the orchestrator's
 * reconcileCancellations as the orchestrator login. Ordering is controlled by test gates at documented commit boundaries, and contention
 * is observed by backend PID in pg_stat_activity, never inferred from sleeps. Direct SQL trigger tests remain in
 * cancellation-concurrency.integration.test.ts as a separate database layer.
 */

const hooks = {};
let h: Harness;
const openGates: Array<{ open: () => void }> = [];

beforeAll(async () => { h = await createHarness(); });
afterAll(async () => {
  for (const gate of openGates) gate.open();
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
const delay = (ms: number): Promise<void> => new Promise((resolve) => { const t = setTimeout(resolve, ms); t.unref(); });

/** Polls until `condition` holds, or fails naming what was awaited. */
async function until(condition: () => Promise<boolean>, label: string, attempts = 400): Promise<void> {
  for (let i = 0; i < attempts; i += 1) {
    if (await condition()) return;
    await delay(25);
  }
  throw new Error(`timed out waiting for: ${label}`);
}
/** True when some session blocked on a lock matching `pattern` is blocked by `blockerPid`. */
const blockedBy = async (blockerPid: number, pattern: string): Promise<boolean> => Number((await h.adminPool.query<{ n: string }>(
  `SELECT count(*)::text AS n FROM pg_stat_activity w WHERE w.datname = current_database() AND w.wait_event_type = 'Lock'
     AND w.query ILIKE $1 AND $2 = ANY(pg_blocking_pids(w.pid))`, [`%${pattern}%`, blockerPid])).rows[0].n) > 0;
/** True when some session blocked on a lock matching `pattern` is blocked by a session idle inside an open transaction. */
const blockedByIdleTransaction = async (pattern: string): Promise<boolean> => Number((await h.adminPool.query<{ n: string }>(
  `SELECT count(*)::text AS n FROM pg_stat_activity w
    WHERE w.datname = current_database() AND w.wait_event_type = 'Lock' AND w.query ILIKE $1
      AND EXISTS (SELECT 1 FROM pg_stat_activity b WHERE b.pid = ANY(pg_blocking_pids(w.pid)) AND b.state = 'idle in transaction')`,
  [`%${pattern}%`])).rows[0].n) > 0;
const noIdleTransactions = async (): Promise<boolean> => Number((await h.adminPool.query<{ n: string }>(
  `SELECT count(*)::text AS n FROM pg_stat_activity WHERE datname = current_database() AND state LIKE 'idle in transaction%' AND pid <> pg_backend_pid()`,
  [])).rows[0].n) === 0;

const state = async (executionId: string) => (await h.adminPool.query<{ status: string; cancel_requested: boolean; lease_agent_id: string | null;
  next_at: Date | null }>(
  `SELECT status, cancel_requested, lease_agent_id, cancellation_next_attempt_at AS next_at FROM aegis.agent_executions WHERE execution_id = $1`,
  [executionId])).rows[0];
const events = async (executionId: string, eventType: string) => Number((await h.adminPool.query<{ n: string }>(
  'SELECT count(*)::text AS n FROM aegis.agent_execution_events WHERE execution_id = $1 AND event_type = $2', [executionId, eventType])).rows[0].n);
const openGrants = async (executionId: string) => Number((await h.adminPool.query<{ n: string }>(
  `SELECT count(*)::text AS n FROM aegis.agent_grants WHERE execution_id = $1 AND status = 'open'`, [executionId])).rows[0].n);
const requestGrantStatus = async (executionId: string) => (await h.adminPool.query<{ status: string }>(
  `SELECT status FROM aegis.agent_grants WHERE execution_id = $1 AND kind = 'request' ORDER BY created_at LIMIT 1`, [executionId])).rows[0].status;

const reconcile = () => reconcileCancellations(h.pools.orchestrator, hooks, { instance: 'phase-a-races', limit: 50, lockTimeoutMs: 15000 });
async function drainDue(): Promise<void> {
  for (let i = 0; i < 30; i += 1) {
    if ((await reconcile()).candidates === 0) return;
  }
  throw new Error('drain not bounded');
}

/**
 * The production gateway request. `reached` and `proceed` pause inside its transaction, after the flag write and before COMMIT, so a
 * test can hold the gateway's row lock while another session runs.
 */
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

/** The production participant delivery of the request, as the triage login. */
function deliverRequestToTriage(messageId: string, body: Record<string, unknown>, options: { beforeCommit?: (label: string) => Promise<void> } = {}) {
  return receiveMessage(h.pools.triage, options, { receiver: 'triage', peerSpiffeId: SPIFFE.orchestrator, messageId, body });
}

describe('9.1 production-path grant-consumption races (participant login, production receive path)', () => {
  it('9.1a cancellation commits first: the participant receive is refused, the request grant stays open, and reconciliation finalises', async () => {
    await drainDue();
    const started = await startInvestigation(h, { tenantId: NORTH });
    const body = await wireOf(h, started.requestMessageId);
    expect(await gatewayRequest(started.executionId)).toMatchObject({ accepted: true, state: 'cancel_requested' });
    const received = await deliverRequestToTriage(started.requestMessageId, body);
    expect(received).toMatchObject({ status: 'refused', reason: 'cancel_requested' });
    expect(await requestGrantStatus(started.executionId)).toBe('open');
    await reconcile();
    expect(await state(started.executionId)).toMatchObject({ status: 'cancelled', lease_agent_id: null, next_at: null });
    expect(await openGrants(started.executionId)).toBe(0);
    expect(await events(started.executionId, 'cancelled')).toBe(1);
  }, 60000);

  it('9.1b consumption commits first: the request is consumed, the later cancellation is still effective, and the stale result cannot revive it', async () => {
    await drainDue();
    const started = await startInvestigation(h, { tenantId: NORTH });
    const body = await wireOf(h, started.requestMessageId);
    const received = await deliverRequestToTriage(started.requestMessageId, body);
    expect(received).toMatchObject({ status: 'processed' });
    expect(received.resultMessageId).not.toBeNull();
    expect(await requestGrantStatus(started.executionId)).toBe('consumed');
    expect(await gatewayRequest(started.executionId)).toMatchObject({ accepted: true, state: 'cancel_requested' });
    await reconcile();
    expect(await state(started.executionId)).toMatchObject({ status: 'cancelled', lease_agent_id: null });
    // The triage result arrives at the orchestrator after the cancellation. It must not revive or complete the execution.
    const resultBody = await wireOf(h, received.resultMessageId!);
    await receiveMessage(h.pools.orchestrator, {}, { receiver: 'orchestrator', peerSpiffeId: SPIFFE.triage, messageId: received.resultMessageId!,
      body: resultBody, orchestrator: { spiffeId: SPIFFE.orchestrator, instance: 'phase-a-races' } });
    expect(await state(started.executionId)).toMatchObject({ status: 'cancelled' });
    expect(await events(started.executionId, 'cancelled')).toBe(1);
    expect((await reconcile()).candidates).toBe(0);
    expect(await state(started.executionId)).toMatchObject({ status: 'cancelled' });
  }, 60000);

  it('9.1c concurrent, cancellation first: the gateway holds its row lock, the participant receive queues behind it, and is refused once the cancellation commits', async () => {
    await drainDue();
    const started = await startInvestigation(h, { tenantId: NORTH });
    const body = await wireOf(h, started.requestMessageId);
    const reached = signal<number>();
    const proceed = barrier();
    const cancelling = gatewayRequest(started.executionId, { reached: reached.fire, proceed: proceed.promise });
    const gatewayPid = await bounded(reached.promise, 'gateway holds the execution row lock');
    const receiving = deliverRequestToTriage(started.requestMessageId, body);
    await until(() => blockedBy(gatewayPid, 'aegis.agent_'), 'receive queued behind the gateway');
    proceed.open();
    expect(await bounded(cancelling, 'gateway commit')).toMatchObject({ accepted: true, state: 'cancel_requested' });
    expect(await bounded(receiving, 'queued receive')).toMatchObject({ status: 'refused', reason: 'cancel_requested' });
    expect(await requestGrantStatus(started.executionId)).toBe('open');
    await reconcile();
    expect(await state(started.executionId)).toMatchObject({ status: 'cancelled' });
    expect(await events(started.executionId, 'cancelled')).toBe(1);
  }, 60000);

  it('9.1d concurrent, consumption first: the consumption holds its locks until committed, the cancellation queues behind it, and then takes effect', async () => {
    await drainDue();
    const started = await startInvestigation(h, { tenantId: NORTH });
    const body = await wireOf(h, started.requestMessageId);
    const consumed = signal();
    const proceed = barrier();
    const consuming = deliverRequestToTriage(started.requestMessageId, body, {
      beforeCommit: async (label) => {
        // 'receive:accepted' is emitted after the request grant is consumed (and its trigger share lock is held), before COMMIT.
        if (label === 'receive:accepted') { consumed.fire(); await proceed.promise; }
      },
    });
    await bounded(consumed.promise, 'consumption holds its locks before commit');
    const cancelling = gatewayRequest(started.executionId);
    await until(() => blockedByIdleTransaction('aegis.agent_'), 'cancellation queued behind the open consumption');
    proceed.open();
    expect(await bounded(consuming, 'consumption commit')).toMatchObject({ status: 'processed' });
    expect(await bounded(cancelling, 'queued cancellation')).toMatchObject({ accepted: true, state: 'cancel_requested' });
    expect(await requestGrantStatus(started.executionId)).toBe('consumed');
    await reconcile();
    expect(await state(started.executionId)).toMatchObject({ status: 'cancelled', lease_agent_id: null });
    expect(await openGrants(started.executionId)).toBe(0);
    expect(await events(started.executionId, 'cancelled')).toBe(1);
  }, 60000);
});

describe('9.3 representative process-crash recovery (subprocess reconciliation worker, SIGKILL)', () => {
  it('a committed cancellation survives a SIGKILL inside an uncommitted finalisation; the rollback is clean; a new worker finalises it exactly once', async () => {
    await drainDue();
    const started = await startInvestigation(h, { tenantId: NORTH });
    expect(await gatewayRequest(started.executionId)).toMatchObject({ accepted: true, state: 'cancel_requested' });

    // The worker is paused after its finalisation has written the terminal state and grant revocations, before COMMIT.
    const doomed = spawnMessagingWorker({ op: 'cancel', dbUrl: roleUrl('orchestrator'), pauseBeforeCommit: 'cancel_finalise:applied' });
    await doomed.waitForEvent('PAUSED', 60000);
    doomed.kill();
    await doomed.exited();
    await until(() => noIdleTransactions(), 'the killed session rolled back');

    // The interrupted finalisation left no trace: the request is still committed and pending, nothing is cancelled, no grant is revoked.
    const afterCrash = await state(started.executionId);
    expect(afterCrash).toMatchObject({ cancel_requested: true });
    expect(afterCrash.status).not.toBe('cancelled');
    expect(await events(started.executionId, 'cancelled')).toBe(0);
    expect(await openGrants(started.executionId)).toBeGreaterThan(0);

    // A new worker resumes from the committed state and finalises it.
    const resumed = spawnMessagingWorker({ op: 'cancel', dbUrl: roleUrl('orchestrator') });
    const outcome = await resumed.waitForEvent('RESULT', 60000);
    expect((await resumed.exited()).code).toBe(0);
    expect(outcome.summary).toMatchObject({ applied: 1, halted: false });
    expect(await state(started.executionId)).toMatchObject({ status: 'cancelled', lease_agent_id: null, next_at: null });
    expect(await openGrants(started.executionId)).toBe(0);
    expect(await events(started.executionId, 'cancelled')).toBe(1);

    // No duplicate event and no revival on any later cycle.
    expect((await reconcile()).candidates).toBe(0);
    expect(await state(started.executionId)).toMatchObject({ status: 'cancelled' });
    expect(await events(started.executionId, 'cancelled')).toBe(1);
  }, 120000);
});


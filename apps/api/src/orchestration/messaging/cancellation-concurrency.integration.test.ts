import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createDatabasePool } from '../../storage/database.js';
import { createAgentExecutionStore, joinTransaction, type Fence } from '../persistence/execution-store.js';
import { readCancellationBacklog, reconcileCancellations, type ReconcileOptions } from './cancellation.js';
import { CancellationAuthorityError, verifyCancellationAuthority } from './cancellation-authority.js';
import { withMessagingContext } from './context.js';
import { createHarness, closeHarness, roleUrl, startInvestigation, principalDigest, SPIFFE, NORTH, SOUTH, type Harness } from './testing/support.js';

// Phase A on real PostgreSQL: genuine two-connection lock contention (observed in pg_stat_activity, not slept for), competing reconcilers,
// and starvation, backoff, recovery and restart tests. The reconciliation under test is the production function. Faults are injected
// through its test seam (ReconcileOptions.injectFault), which the runtime never passes.

const hooks = {};
let h: Harness;
const openClients: PoolClient[] = [];
const extraPools: Pool[] = [];

beforeAll(async () => { h = await createHarness(); });
afterAll(async () => {
  for (const c of openClients) c.release();
  for (const p of extraPools) await p.end();
  if (h) await closeHarness(h);
});

const gate = () => {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => { open = resolve; });
  return { promise, open };
};
const signal = () => {
  let fire!: () => void;
  const promise = new Promise<void>((resolve) => { fire = resolve; });
  return { promise, fire };
};

/** Polls pg_stat_activity until at least `count` sessions wait on a lock held by another session and their statement matches `pattern`. */
async function waitForLockWaiters(pattern: string, count = 1): Promise<number> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const result = await h.adminPool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM pg_stat_activity
        WHERE datname = current_database() AND wait_event_type = 'Lock' AND query ILIKE $1
          AND cardinality(pg_blocking_pids(pid)) > 0`, [`%${pattern}%`]);
    const n = Number(result.rows[0].n);
    if (n >= count) return n;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`no lock waiter observed for ${pattern}`);
}

const state = async (executionId: string) => (await h.adminPool.query<{ status: string; cancel_requested: boolean;
  lease_agent_id: string | null; attempts_cancel: number; next_at: Date | null; last_at: Date | null; failure_class: string | null }>(
  `SELECT status, cancel_requested, lease_agent_id, cancellation_attempts AS attempts_cancel, cancellation_next_attempt_at AS next_at,
          cancellation_last_attempt_at AS last_at, cancellation_failure_class AS failure_class
     FROM aegis.agent_executions WHERE execution_id = $1`, [executionId])).rows[0];
const events = async (executionId: string, eventType: string) => Number((await h.adminPool.query<{ n: string }>(
  'SELECT count(*)::text AS n FROM aegis.agent_execution_events WHERE execution_id = $1 AND event_type = $2', [executionId, eventType])).rows[0].n);
const openGrants = async (executionId: string) => Number((await h.adminPool.query<{ n: string }>(
  `SELECT count(*)::text AS n FROM aegis.agent_grants WHERE execution_id = $1 AND status = 'open'`, [executionId])).rows[0].n);

const reconcile = (options: Partial<ReconcileOptions> = {}, pool: Pool = h.pools.orchestrator) =>
  reconcileCancellations(pool, hooks, { instance: 'phase-a', limit: 50, lockTimeoutMs: 15000, ...options });

/** Claims the execution as the orchestrator (a live lease held by a stale holder). */
async function holdLease(tenant: string, executionId: string, instance: string): Promise<Fence> {
  return withMessagingContext(h.pools.orchestrator, { tenantId: tenant }, async (client) => {
    const store = createAgentExecutionStore(joinTransaction(client, tenant), hooks);
    const claim = await store.claim({ tenantId: tenant, executionId, spiffeId: SPIFFE.orchestrator, instance, leaseSeconds: 600 });
    if (!claim.ok) throw new Error(`claim refused: ${claim.reason}`);
    return { tenantId: tenant, executionId, agentId: claim.value.agentId, instance, fencingToken: claim.value.fencingToken };
  });
}

/** A fenced write attempted by a holder whose lease has been finalised or preempted. Refused as stale or as cancelled. */
const staleWrite = (tenant: string, executionId: string, fence: Fence) => withMessagingContext(h.pools.orchestrator, { tenantId: tenant }, (client) =>
  createAgentExecutionStore(joinTransaction(client, tenant), hooks).release({ ...fence, executionId }, 'failed', 'late_write'));

/** Requests cancellation through the gateway's own path and commits it. */
const requestCancelCommitted = (tenant: string, executionId: string) => withMessagingContext(h.pools.gateway, { tenantId: tenant }, (client) =>
  createAgentExecutionStore(joinTransaction(client, tenant), hooks).requestCancel(tenant, executionId, principalDigest('phase-a'), 'user_request'));

/** A committed cancellation request on a live lease: the state the reconciler must finalise. */
async function pendingCancellation(tenant = NORTH): Promise<{ executionId: string; fence: Fence }> {
  const { executionId } = await startInvestigation(h, { tenantId: tenant });
  const fence = await holdLease(tenant, executionId, `holder-${executionId.slice(0, 8)}`);
  const requested = await requestCancelCommitted(tenant, executionId);
  if (!requested.ok || requested.value.state !== 'cancel_requested') throw new Error('expected a pending cancellation');
  return { executionId, fence };
}

/** Drains every due cancellation (no faults) until none is due. Bounded. Keeps each test's starting point clean. */
async function drainDue(): Promise<void> {
  for (let i = 0; i < 30; i += 1) {
    const summary = await reconcile();
    if (summary.candidates === 0) return;
  }
  throw new Error('drain not bounded');
}

/** Makes a failed cancellation due again without waiting for its backoff. Test-only persisted timestamp. */
const makeDue = (executionId: string) => h.adminPool.query(
  `UPDATE aegis.agent_executions SET cancellation_next_attempt_at = clock_timestamp() - interval '1 second' WHERE execution_id = $1`, [executionId]);

describe('A5 real two-session races on the execution row lock', () => {
  it('startup validation passes for the real orchestrator login, and the gateway login cannot pass as the orchestrator', async () => {
    await expect(verifyCancellationAuthority(h.pools.orchestrator, { identity: true })).resolves.toBeUndefined();
    await expect(verifyCancellationAuthority(h.pools.gateway, { identity: true })).rejects.toBeInstanceOf(CancellationAuthorityError);
  });

  it('A5.1 cancellation wins: the cancellation holds the lock, a competing completion waits and is refused, and reconciliation finalises', async () => {
    const { executionId } = await startInvestigation(h, { tenantId: NORTH });
    const fence = await holdLease(NORTH, executionId, `holder-a51-${executionId.slice(0, 8)}`);
    const holding = signal();
    const commit = gate();
    const cancellation = withMessagingContext(h.pools.gateway, { tenantId: NORTH }, async (client) => {
      const outcome = await createAgentExecutionStore(joinTransaction(client, NORTH), hooks).requestCancel(NORTH, executionId,
        principalDigest('a51'), 'user_request');
      holding.fire();
      await commit.promise;
      return outcome;
    });
    await holding.promise;
    const completion = withMessagingContext(h.pools.orchestrator, { tenantId: NORTH }, (client) =>
      createAgentExecutionStore(joinTransaction(client, NORTH), hooks).release(fence, 'succeeded', 'completed'));
    await waitForLockWaiters('agent_executions');
    commit.open();
    expect(await cancellation).toMatchObject({ ok: true, value: { state: 'cancel_requested' } });
    expect(await completion).toMatchObject({ ok: false, reason: 'cancel_requested' });
    await reconcile();
    expect(await state(executionId)).toMatchObject({ status: 'cancelled', cancel_requested: true, lease_agent_id: null });
    expect(await openGrants(executionId)).toBe(0);
    expect(await events(executionId, 'cancelled')).toBe(1);
    expect(await staleWrite(NORTH, executionId, fence)).toMatchObject({ ok: false });
  }, 60000);

  it('A5.2 completion wins: the cancellation waits on the lock, then sees the terminal result and changes nothing', async () => {
    const { executionId } = await startInvestigation(h, { tenantId: NORTH });
    const fence = await holdLease(NORTH, executionId, `holder-a52-${executionId.slice(0, 8)}`);
    const holding = signal();
    const completionGate = gate();
    const completion = withMessagingContext(h.pools.orchestrator, { tenantId: NORTH }, async (client) => {
      const outcome = await createAgentExecutionStore(joinTransaction(client, NORTH), hooks).release(fence, 'succeeded', 'completed');
      holding.fire();
      await completionGate.promise;
      return outcome;
    });
    await holding.promise;
    const cancellation = requestCancelCommitted(NORTH, executionId);
    await waitForLockWaiters('agent_executions');
    completionGate.open();
    expect(await completion).toMatchObject({ ok: true });
    expect(await cancellation).toMatchObject({ ok: false, reason: 'terminal' });
    expect(await state(executionId)).toMatchObject({ status: 'succeeded', cancel_requested: false, lease_agent_id: null });
    expect(await events(executionId, 'cancelled')).toBe(0);
    await reconcile();
    expect((await state(executionId)).status).toBe('succeeded');
  }, 60000);

  it('A5.3a grant consumption first: a consumption that holds the execution lock makes cancellation wait, then finalises', async () => {
    const { executionId } = await startInvestigation(h, { tenantId: NORTH });
    const grant = (await h.adminPool.query<{ grant_id: string }>(
      `SELECT grant_id FROM aegis.agent_grants WHERE execution_id = $1 AND kind = 'request' AND status = 'open' LIMIT 1`, [executionId])).rows[0];
    expect(grant).toBeDefined();
    const consumer = await h.adminPool.connect();
    openClients.push(consumer);
    const consuming = signal();
    const consumeGate = gate();
    const consumption = (async () => {
      await consumer.query('BEGIN');
      await consumer.query(`UPDATE aegis.agent_grants SET status = 'consumed', consumed_at = clock_timestamp(), consumed_by_agent = 'triage',
          consumed_by_fencing_token = 0 WHERE grant_id = $1`, [grant.grant_id]);
      consuming.fire();
      await consumeGate.promise;
      await consumer.query('COMMIT');
    })();
    await consuming.promise;
    const cancellation = withMessagingContext(h.pools.gateway, { tenantId: NORTH }, (client) =>
      createAgentExecutionStore(joinTransaction(client, NORTH), hooks).requestCancel(NORTH, executionId, principalDigest('a53a'), 'user_request'));
    await waitForLockWaiters('agent_executions');
    consumeGate.open();
    await consumption;
    expect(await cancellation).toMatchObject({ ok: true, value: { state: 'cancelled' } });
    expect(await state(executionId)).toMatchObject({ status: 'cancelled' });
    const consumed = await h.adminPool.query<{ status: string }>('SELECT status FROM aegis.agent_grants WHERE grant_id = $1', [grant.grant_id]);
    expect(consumed.rows[0].status).toBe('consumed');
  }, 60000);

  it('A5.3b cancellation first: the database refuses a request-grant consumption that follows a committed cancellation', async () => {
    const { executionId, fence } = await pendingCancellation();
    const grant = (await h.adminPool.query<{ grant_id: string }>(
      `SELECT grant_id FROM aegis.agent_grants WHERE execution_id = $1 AND kind = 'request' AND status = 'open' LIMIT 1`, [executionId])).rows[0];
    expect(fence).toBeDefined();
    expect(grant).toBeDefined();
    const consumed = await h.adminPool.connect().then(async (c) => {
      openClients.push(c);
      try {
        await c.query('BEGIN');
        await c.query(`UPDATE aegis.agent_grants SET status = 'consumed', consumed_at = clock_timestamp(), consumed_by_agent = 'triage',
            consumed_by_fencing_token = 0 WHERE grant_id = $1`, [grant.grant_id]);
        await c.query('COMMIT');
        return null;
      } catch (error) {
        await c.query('ROLLBACK');
        return (error as { code?: string }).code ?? 'error';
      }
    });
    expect(consumed).toBe('42501');
    expect(await openGrants(executionId)).toBe(0);
  }, 60000);

  it('A5.4 competing reconcilers: two instances on the same candidate yield one cancelled event and no revived execution', async () => {
    const { executionId } = await pendingCancellation();
    const second = createDatabasePool(roleUrl('orchestrator'), 2);
    extraPools.push(second);
    const blocker = await h.adminPool.connect();
    openClients.push(blocker);
    await blocker.query('BEGIN');
    await blocker.query('SELECT 1 FROM aegis.agent_executions WHERE execution_id = $1 FOR UPDATE', [executionId]);
    const first = reconcile({ instance: 'instance-1' }, h.pools.orchestrator);
    const other = reconcile({ instance: 'instance-2' }, second);
    await waitForLockWaiters('agent_executions', 2);
    await blocker.query('COMMIT');
    const [a, b] = await Promise.all([first, other]);
    expect(a.systemic + b.systemic + a.unrecorded + b.unrecorded).toBe(0);
    expect(await events(executionId, 'cancelled')).toBe(1);
    expect(await state(executionId)).toMatchObject({ status: 'cancelled', lease_agent_id: null, attempts_cancel: 0, next_at: null });
  }, 60000);
});

describe('A6 starvation, backoff, recovery and restart on real PostgreSQL', () => {
  it('A6.1 a poisoned cancellation ahead of a healthy one is rescheduled, and the healthy one completes in the next cycle', async () => {
    await drainDue();
    const poisoned = await pendingCancellation();
    const healthy = await pendingCancellation();
    const fault = (phase: 'finalise' | 'record', _t: string, id: string) =>
      phase === 'finalise' && id === poisoned.executionId ? new Error('synthetic transient fault') : undefined;
    const first = await reconcile({ limit: 1, injectFault: fault });
    expect(first).toMatchObject({ candidates: 1, transient: 1, applied: 0 });
    const afterFirst = await state(poisoned.executionId);
    expect(afterFirst).toMatchObject({ attempts_cancel: 1, failure_class: 'transient' });
    expect(afterFirst.next_at!.getTime()).toBeGreaterThan(Date.now() - 1000);
    const second = await reconcile({ limit: 1, injectFault: fault });
    expect(second).toMatchObject({ candidates: 1, applied: 1 });
    expect((await state(healthy.executionId)).status).toBe('cancelled');
    const third = await reconcile({ limit: 1, injectFault: fault });
    expect(third.candidates).toBe(0);
    expect((await state(poisoned.executionId)).attempts_cancel).toBe(1);
  }, 60000);

  it('A6.2 more poisoned candidates than the batch: the healthy one completes within ceil(poisoned / batch) + 1 cycles', async () => {
    await drainDue();
    const poisoned: string[] = [];
    for (let i = 0; i < 5; i += 1) poisoned.push((await pendingCancellation()).executionId);
    const healthy = (await pendingCancellation()).executionId;
    const set = new Set(poisoned);
    const fault = (phase: 'finalise' | 'record', _t: string, id: string) =>
      phase === 'finalise' && set.has(id) ? new Error('synthetic transient fault') : undefined;
    let cycles = 0;
    while ((await state(healthy)).status !== 'cancelled' && cycles < 10) {
      cycles += 1;
      await reconcile({ limit: 2, injectFault: fault });
    }
    expect(cycles).toBeLessThanOrEqual(Math.ceil(5 / 2) + 1);
    expect((await state(healthy)).status).toBe('cancelled');
  }, 60000);

  it('A6.3 backoff: attempts persist, ineligible retries are not selected, and the interval is capped at 60 seconds', async () => {
    await drainDue();
    const { executionId } = await pendingCancellation();
    const fault = (phase: 'finalise' | 'record', _t: string, id: string) =>
      phase === 'finalise' && id === executionId ? new Error('synthetic transient fault') : undefined;
    await reconcile({ injectFault: fault });
    const once = await state(executionId);
    expect(once.attempts_cancel).toBe(1);
    expect((await reconcile({ injectFault: fault })).candidates).toBe(0);
    await makeDue(executionId);
    await reconcile({ injectFault: fault });
    expect((await state(executionId)).attempts_cancel).toBe(2);
    // Test-only persisted state near the saturation point. The three retry fields are set together, as the table's CHECK requires.
    await h.adminPool.query(`UPDATE aegis.agent_executions SET cancellation_attempts = 999, cancellation_last_attempt_at = clock_timestamp(),
        cancellation_failure_class = 'transient' WHERE execution_id = $1`, [executionId]);
    await makeDue(executionId);
    await reconcile({ injectFault: fault });
    const saturated = await state(executionId);
    expect(saturated.attempts_cancel).toBe(1000);
    const interval = (saturated.next_at!.getTime() - saturated.last_at!.getTime()) / 1000;
    expect(interval).toBeGreaterThan(59);
    expect(interval).toBeLessThanOrEqual(60.5);
    await makeDue(executionId);
    await reconcile({ injectFault: fault });
    expect((await state(executionId)).attempts_cancel).toBe(1000);
  }, 60000);

  it('A6.4 recovery: once the fault clears, a persistently failing cancellation resolves and its history remains', async () => {
    await drainDue();
    const { executionId } = await pendingCancellation();
    const fault = (phase: 'finalise' | 'record', _t: string, id: string) =>
      phase === 'finalise' && id === executionId ? new Error('synthetic transient fault') : undefined;
    await reconcile({ injectFault: fault });
    await makeDue(executionId);
    expect(await reconcile()).toMatchObject({ applied: 1 });
    expect(await state(executionId)).toMatchObject({ status: 'cancelled', attempts_cancel: 1, next_at: null });
  }, 60000);

  it('A6.5 failure recorded but finalisation rolled back: an interruption between the two transactions leaves the row due and retryable', async () => {
    await drainDue();
    const { executionId } = await pendingCancellation();
    const crash = (phase: 'finalise' | 'record', _t: string, id: string) =>
      id === executionId && phase === 'record' ? new Error('synthetic record fault') : phase === 'finalise' && id === executionId ? new Error('synthetic transient fault') : undefined;
    const interrupted = await reconcile({ injectFault: crash });
    expect(interrupted).toMatchObject({ unrecorded: 1, halted: true });
    expect(await state(executionId)).toMatchObject({ status: 'pending', attempts_cancel: 0, failure_class: null });
    expect(await reconcile()).toMatchObject({ applied: 1 });
    expect((await state(executionId)).status).toBe('cancelled');
  }, 60000);

  it('A6.6 restart: a fresh pool with no in-memory state resumes a persisted retry schedule', async () => {
    await drainDue();
    const { executionId } = await pendingCancellation();
    const fault = (phase: 'finalise' | 'record', _t: string, id: string) =>
      phase === 'finalise' && id === executionId ? new Error('synthetic transient fault') : undefined;
    await reconcile({ injectFault: fault });
    const restarted = createDatabasePool(roleUrl('orchestrator'), 2);
    extraPools.push(restarted);
    expect(await reconcile({}, restarted)).toMatchObject({ candidates: 0 });
    await makeDue(executionId);
    expect(await reconcile({}, restarted)).toMatchObject({ applied: 1 });
  }, 60000);

  it('A6.7 a locked execution does not block unrelated cancellations: the lock times out and the healthy one still completes', async () => {
    await drainDue();
    const locked = await pendingCancellation();
    const healthy = await pendingCancellation();
    const holder = await h.adminPool.connect();
    openClients.push(holder);
    await holder.query('BEGIN');
    await holder.query('SELECT 1 FROM aegis.agent_executions WHERE execution_id = $1 FOR UPDATE', [locked.executionId]);
    try {
      const summary = await reconcile({ lockTimeoutMs: 300 });
      expect(summary).toMatchObject({ deferred: 1, halted: false });
      expect((await state(healthy.executionId)).status).toBe('cancelled');
    } finally {
      await holder.query('ROLLBACK');
    }
    expect((await state(locked.executionId)).attempts_cancel).toBe(0);
    expect(await reconcile()).toMatchObject({ applied: 1 });
  }, 60000);

  it('A6.8 cross-tenant isolation: finalising a SOUTH cancellation under a NORTH context finds nothing', async () => {
    const { executionId } = await pendingCancellation(SOUTH);
    const result = await withMessagingContext(h.pools.orchestrator, { tenantId: NORTH }, (client) =>
      createAgentExecutionStore(joinTransaction(client, NORTH), hooks).finaliseCancellation(NORTH, executionId, 'wrong-tenant'));
    expect(result).toMatchObject({ ok: false, reason: 'not_found' });
    expect((await state(executionId)).status).toBe('pending');
    await reconcile();
    expect((await state(executionId)).status).toBe('cancelled');
  }, 60000);

  it('A6.9 participants cannot discover cancellations, read the backlog, or write retry state', async () => {
    const triage = (sql: string) => withMessagingContext(h.pools.triage, { tenantId: NORTH }, (client) => client.query(sql, []));
    await expect(triage('SELECT * FROM aegis.orchestrator_due_cancellations(10)')).rejects.toThrow(/permission denied/);
    await expect(triage('SELECT * FROM aegis.orchestrator_cancellation_backlog()')).rejects.toThrow(/permission denied/);
    await expect(triage(`UPDATE aegis.agent_executions SET cancellation_attempts = 0`)).rejects.toThrow(/permission denied/);
    await expect(triage(`UPDATE aegis.agent_executions SET cancellation_next_attempt_at = NULL`)).rejects.toThrow(/permission denied/);
  }, 60000);

  it('A6.10 backlog visibility exposes counts and ages only, and reports a failing cancellation', async () => {
    await drainDue();
    const { executionId } = await pendingCancellation();
    await reconcile({ injectFault: (phase, _t, id) => phase === 'finalise' && id === executionId ? new Error('synthetic') : undefined });
    const backlog = await readCancellationBacklog(h.pools.orchestrator);
    expect(backlog.failing).toBeGreaterThanOrEqual(1);
    expect(backlog.maxAttempts).toBeGreaterThanOrEqual(1);
    expect(Object.keys(backlog).sort()).toEqual(['failing', 'maxAttempts', 'oldestRequestAgeSeconds', 'overdue', 'pending']);
    await reconcile();
  }, 60000);

  it('A6.11 idempotency: repeated cycles after finalisation change nothing', async () => {
    await drainDue();
    const { executionId } = await pendingCancellation();
    await reconcile();
    const once = await state(executionId);
    await reconcile();
    await reconcile();
    expect(await state(executionId)).toEqual(once);
    expect(await events(executionId, 'cancelled')).toBe(1);
  }, 60000);
});

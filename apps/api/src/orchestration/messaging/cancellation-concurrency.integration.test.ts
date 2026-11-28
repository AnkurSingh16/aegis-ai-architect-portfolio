import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createDatabasePool } from '../../storage/database.js';
import { createAgentExecutionStore, joinTransaction, type Fence } from '../persistence/execution-store.js';
import { requestCancellation } from '../../investigation/gateway.js';
import type { TenantQueryable } from '../../security/tool-approval-store.js';
import { readCancellationBacklog, reconcileCancellations, type ReconcileOptions } from './cancellation.js';
import { CancellationAuthorityError, verifyCancellationAuthority } from './cancellation-authority.js';
import { withMessagingContext } from './context.js';
import { createHarness, closeHarness, readerPrincipal, roleUrl, startInvestigation, SPIFFE, NORTH, SOUTH, type Harness,
  isolateCancellationBacklog, pendingCancellationCount } from './testing/support.js';

// Phase A on real PostgreSQL. Every checked-out connection is released in a finally block; every barrier is released or aborted on every
// path; every started operation is settled before a test ends. Lock contention is observed by identified backend PID (the blocker is the
// PID of the session that holds the lock), never inferred from sleeps. The reconciler and the gateway are the production functions.

const hooks = {};
let h: Harness;
const extraPools: Pool[] = [];

beforeAll(async () => { h = await createHarness(); });
// Fixture lifecycle. Every test starts from an empty cancellation backlog and leaves one behind. Isolation uses only the production
// reconciler and test-only scheduling (see isolateCancellationBacklog); a test that fails an assertion is cleaned up the same way.
beforeEach(async () => { await isolateCancellationBacklog(h); });
afterEach(async () => { await isolateCancellationBacklog(h); });
afterAll(async () => {
  for (const p of extraPools) await p.end().catch(() => undefined);
  if (h) await closeHarness(h);
});

/** A one-shot barrier. `open` releases every waiter; `abort` releases them with an error so nothing waits forever. */
function barrier() {
  let resolve!: () => void;
  let reject!: (e: Error) => void;
  const promise = new Promise<void>((res, rej) => { resolve = res; reject = rej; });
  return { promise, open: () => resolve(), abort: (e: Error) => reject(e) };
}
/** A signal that fires once, carrying a value (for example the PID of the session that reached the point). */
function signal<T = void>() {
  let fire!: (value: T) => void;
  const promise = new Promise<T>((resolve) => { fire = resolve; });
  return { promise, fire };
}
/** Fails with a named error if `promise` does not settle within `ms`. The timer is cleared when the race ends, so none outlives its test. */
function bounded<T>(promise: Promise<T>, label: string, ms = 20000): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const limit = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`timed out: ${label}`)), ms); timer.unref(); });
  return Promise.race([promise, limit]).finally(() => clearTimeout(timer));
}
const delay = (ms: number): Promise<void> => new Promise((resolve) => { const t = setTimeout(resolve, ms); t.unref(); });

/**
 * Every operation a test starts is registered here, and every checked-out client is released exactly once by close(). Cleanup is
 * dependency-aware, because a started operation can be waiting on a lock held by one of the test's own sessions:
 * 1. abort every barrier, so an operation parked on a test gate unwinds with an error;
 * 2. give started operations a short grace period to settle on their own;
 * 3. if any are still waiting, terminate the test's own sessions. Their open transactions roll back and their row locks are freed, so a
 *    waiter blocked by them proceeds. This runs only after the test's assertions, so no test observes a terminated session;
 * 4. settle every started operation, bounded, so a hang becomes a named failure rather than a stuck run;
 * 5. release each client once; a client whose session was terminated is destroyed, not returned to the pool.
 */
class Scenario {
  private readonly started: Array<Promise<unknown>> = [];
  private readonly clients: Array<{ client: PoolClient; pid: number; released: boolean; terminated: boolean; onError: (e: Error) => void }> = [];
  /** Errors from sessions the test did not terminate. Reported at close, so an unexpected PostgreSQL error stays visible. */
  private readonly unexpected: Error[] = [];
  private readonly barriers: Array<{ abort: (e: Error) => void }> = [];
  start<T>(promise: Promise<T>): Promise<T> {
    // Observe the rejection at once, so a failure that is awaited later is never an unhandled rejection. The caller still awaits `promise`.
    promise.catch(() => undefined);
    this.started.push(promise);
    return promise;
  }
  async client(pool: Pool): Promise<PoolClient> {
    const client = await pool.connect();
    const pid = Number((await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid', [])).rows[0].pid);
    // A checked-out session can emit 'error' when the server ends it. The listener is scoped to this entry and removed on release.
    const entry = { client, pid, released: false, terminated: false, onError: (e: Error) => { if (!entry.terminated) this.unexpected.push(e); } };
    client.on('error', entry.onError);
    this.clients.push(entry);
    return client;
  }
  track<B extends { abort: (e: Error) => void }>(b: B): B { this.barriers.push(b); return b; }
  async close(): Promise<void> {
    for (const b of this.barriers) b.abort(new Error('scenario closed'));
    const settled = Promise.allSettled(this.started);
    const graceful = await Promise.race([settled.then(() => true), delay(1500).then(() => false)]);
    if (!graceful) {
      for (const entry of this.clients) {
        // Only sessions the test owns are terminated. Each is marked first, so its expected termination error is not counted as unexpected.
        entry.terminated = true;
        await bounded(h.adminPool.query('SELECT pg_terminate_backend($1)', [entry.pid]), `terminate session ${entry.pid}`, 5000).catch(() => undefined);
      }
    }
    try {
      await bounded(settled, 'scenario operations', 15000);
    } finally {
      for (const entry of this.clients) {
        if (entry.released) continue;
        entry.released = true;
        let broken = entry.terminated;
        if (!broken) {
          try { await entry.client.query('ROLLBACK'); } catch { broken = true; }
        }
        entry.client.removeListener('error', entry.onError);
        // A broken or terminated session is destroyed, never returned to the pool. Each client is released exactly once.
        entry.client.release(broken ? true : undefined);
      }
    }
    if (this.unexpected.length > 0) throw new Error(`unexpected session error: ${this.unexpected[0].message}`);
  }
}

/** Waits until `count` sessions matching `pattern` are queued behind `blockerPid`. Returns the number observed. */
async function waitingOn(blockerPid: number, pattern: string, count: number): Promise<number> {
  let observed = 0;
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const result = await h.adminPool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM pg_stat_activity
        WHERE datname = current_database() AND wait_event_type = 'Lock' AND query ILIKE $1 AND $2 = ANY(pg_blocking_pids(pid))`,
      [`%${pattern}%`, blockerPid]);
    observed = Number(result.rows[0].n);
    if (observed >= count) return observed;
    await delay(25);
  }
  throw new Error(`expected ${count} sessions blocked by pid ${blockerPid}, observed ${observed}`);
}

/** The PIDs of sessions waiting on a lock whose statement matches `pattern`. */
async function lockWaiters(pattern: string): Promise<number[]> {
  const result = await h.adminPool.query<{ pid: number }>(
    `SELECT pid FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND query ILIKE $1`, [`%${pattern}%`]);
  return result.rows.map((r) => r.pid);
}
/** Waits until a session matching `pattern` is blocked by `blockerPid`, identified by PID. Returns the waiter PID. */
async function waitBlockedBy(blockerPid: number, pattern: string): Promise<number> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    for (const pid of await lockWaiters(pattern)) {
      if ((await h.adminPool.query<{ b: number }>('SELECT unnest(pg_blocking_pids($1)) AS b', [pid])).rows.some((r) => r.b === blockerPid)) return pid;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`no session blocked by pid ${blockerPid} matching ${pattern}`);
}

/** A point-in-time view of this database's sessions, attached to any wait failure so the lock state is recorded, not guessed. */
async function lockSnapshot(): Promise<string> {
  const rows = await h.adminPool.query<{ pid: number; state: string; wait: string | null; blocked_by: string; query: string }>(
    `SELECT a.pid, a.state, a.wait_event_type AS wait, array_to_string(pg_blocking_pids(a.pid), ',') AS blocked_by, left(a.query, 90) AS query
       FROM pg_stat_activity a WHERE a.datname = current_database() AND a.pid <> pg_backend_pid() ORDER BY a.pid`, []);
  return rows.rows.map((r) => `pid=${r.pid} state=${r.state} wait=${r.wait ?? '-'} blocked_by=[${r.blocked_by}] q=${JSON.stringify(r.query)}`).join('\n');
}
/**
 * Waits until a session is queued on a lock on `pattern` whose blocker is idle inside an open transaction (the holder). Observes the
 * direct blocking PIDs of each waiter, so a chain of waiters is recognised by its holder, not by a guessed count.
 */
async function waitForQueuedBehindHolder(pattern: string): Promise<{ waiting: number; holderPid: number | null }> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const rows = await h.adminPool.query<{ holder: number }>(
      `SELECT DISTINCT b.pid AS holder FROM pg_stat_activity w
         CROSS JOIN LATERAL unnest(pg_blocking_pids(w.pid)) AS blocker(pid)
         JOIN pg_stat_activity b ON b.pid = blocker.pid
        WHERE w.datname = current_database() AND w.wait_event_type = 'Lock' AND w.query ILIKE $1 AND b.state = 'idle in transaction'`,
      [`%${pattern}%`]);
    if (rows.rows.length > 0) {
      const waiting = Number((await h.adminPool.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM pg_stat_activity w WHERE w.datname = current_database() AND w.wait_event_type = 'Lock' AND w.query ILIKE $1`,
        [`%${pattern}%`])).rows[0].n);
      return { waiting, holderPid: rows.rows[0].holder };
    }
    await delay(25);
  }
  throw new Error(`no session queued behind an idle-in-transaction holder on ${pattern}. Snapshot:\n${await lockSnapshot()}`);
}

const pidOf = async (client: TenantQueryable): Promise<number> =>
  Number((await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid', [])).rows[0].pid);

const state = async (executionId: string) => (await h.adminPool.query<{ status: string; cancel_requested: boolean;
  lease_agent_id: string | null; attempts_cancel: number; next_at: Date | null; last_at: Date | null; failure_class: string | null }>(
  `SELECT status, cancel_requested, lease_agent_id, cancellation_attempts AS attempts_cancel, cancellation_next_attempt_at AS next_at,
          cancellation_last_attempt_at AS last_at, cancellation_failure_class AS failure_class
     FROM aegis.agent_executions WHERE execution_id = $1`, [executionId])).rows[0];
const events = async (executionId: string, eventType: string) => Number((await h.adminPool.query<{ n: string }>(
  'SELECT count(*)::text AS n FROM aegis.agent_execution_events WHERE execution_id = $1 AND event_type = $2', [executionId, eventType])).rows[0].n);
const openGrants = async (executionId: string) => Number((await h.adminPool.query<{ n: string }>(
  `SELECT count(*)::text AS n FROM aegis.agent_grants WHERE execution_id = $1 AND status = 'open'`, [executionId])).rows[0].n);
/** The request grant addressed to triage: the grant that the delivered triage request consumes. A leased execution also holds other open grants. */
const requestGrant = async (executionId: string) => (await h.adminPool.query<{ grant_id: string }>(
  `SELECT grant_id FROM aegis.agent_grants WHERE execution_id = $1 AND kind = 'request' AND to_agent = 'triage' AND status = 'open'`, [executionId])).rows[0];
const grantStatusOf = async (grantId: string) => (await h.adminPool.query<{ status: string }>(
  'SELECT status FROM aegis.agent_grants WHERE grant_id = $1', [grantId])).rows[0].status;

/** The scheduling generation, as text: it is a bigint and is never converted to a JavaScript number. */
const generationOf = async (executionId: string): Promise<string> => (await h.adminPool.query<{ g: string }>(
  'SELECT cancellation_generation::text AS g FROM aegis.agent_executions WHERE execution_id = $1', [executionId])).rows[0].g;
/** Sets the retry state directly (admin, test-only), keeping every CHECK constraint satisfied. */
const setRetryState = (executionId: string, attempts: number, generation: string) => h.adminPool.query(
  `UPDATE aegis.agent_executions SET cancellation_attempts = $2, cancellation_generation = $3::bigint,
          cancellation_last_attempt_at = clock_timestamp(), cancellation_failure_class = 'transient',
          cancellation_next_attempt_at = clock_timestamp() - interval '1 second'
    WHERE execution_id = $1`, [executionId, attempts, generation]);

const reconcile = (options: Partial<ReconcileOptions> = {}, pool: Pool = h.pools.orchestrator) =>
  reconcileCancellations(pool, hooks, { instance: 'phase-a', limit: 50, lockTimeoutMs: 15000, ...options });

/** The gateway's production runner, with an optional pause inside the transaction (after the request statement, before COMMIT). */
type Pause = { reached: (pid: number) => void; proceed: Promise<void> };
const gatewayRunner = (pause?: Pause): never => ((tenant: string, op: (c: TenantQueryable) => Promise<unknown>) =>
  withMessagingContext(h.pools.gateway, { tenantId: tenant }, async (client) => {
    const result = await op(client);
    if (pause) { pause.reached(await pidOf(client)); await pause.proceed; }
    return result;
  })) as unknown as never;
const gatewayRequest = (tenant: string, executionId: string, pause?: Pause) =>
  requestCancellation(gatewayRunner(pause) as never, readerPrincipal(), { tenantId: tenant, executionId, reason: 'user_request' });

/** Claims the execution as the orchestrator. The lease stays live until released or it expires. */
async function holdLease(tenant: string, executionId: string, instance: string): Promise<Fence> {
  return withMessagingContext(h.pools.orchestrator, { tenantId: tenant }, async (client) => {
    const store = createAgentExecutionStore(joinTransaction(client, tenant), hooks);
    const claim = await store.claim({ tenantId: tenant, executionId, spiffeId: SPIFFE.orchestrator, instance, leaseSeconds: 600 });
    if (!claim.ok) throw new Error(`claim refused: ${claim.reason}`);
    return { tenantId: tenant, executionId, agentId: claim.value.agentId, instance, fencingToken: claim.value.fencingToken };
  });
}

/** Creates a cancellation request through the production gateway path and commits it (no lease, or a live lease if `leased`). */
async function pendingCancellation(tenant = NORTH, leased = false): Promise<{ executionId: string; fence: Fence | null }> {
  const { executionId } = await startInvestigation(h, { tenantId: tenant });
  const fence = leased ? await holdLease(tenant, executionId, `holder-${executionId.slice(0, 8)}`) : null;
  const requested = await gatewayRequest(tenant, executionId);
  if (!requested.accepted || requested.state !== 'cancel_requested') throw new Error(`expected a request, got ${requested.state}`);
  return { executionId, fence };
}

/** Establishes an empty backlog (see isolateCancellationBacklog). Kept as the scenario's explicit starting point. */
const drainDue = (): Promise<void> => isolateCancellationBacklog(h);
/**
 * Holds a cancellation out of discovery for the rest of the scenario, by its persisted eligibility time. Used so that a scenario's
 * sequence of cycles does not depend on how much real time its backoff has consumed. The afterEach isolation restores it.
 */
const makeIneligible = (executionId: string) => h.adminPool.query(
  `UPDATE aegis.agent_executions SET cancellation_next_attempt_at = clock_timestamp() + interval '1 hour' WHERE execution_id = $1`, [executionId]);
/** Whether the persisted next attempt lies in the future of the database clock: the backoff the production code recorded. */
const isScheduledInFuture = async (executionId: string): Promise<boolean> => (await h.adminPool.query<{ future: boolean }>(
  `SELECT (cancellation_next_attempt_at > clock_timestamp()) AS future FROM aegis.agent_executions WHERE execution_id = $1`, [executionId])).rows[0].future;
/** Makes a failed cancellation due again without waiting for its backoff. Test-only persisted timestamp. */
const makeDue = (executionId: string) => h.adminPool.query(
  `UPDATE aegis.agent_executions SET cancellation_next_attempt_at = clock_timestamp() - interval '1 second' WHERE execution_id = $1`, [executionId]);

describe('startup authority on the real runtime identities', () => {
  it('the orchestrator login passes validation, and the gateway login is refused as the orchestrator', async () => {
    await expect(verifyCancellationAuthority(h.pools.orchestrator, { identity: true })).resolves.toBeUndefined();
    await expect(verifyCancellationAuthority(h.pools.gateway, { identity: true })).rejects.toBeInstanceOf(CancellationAuthorityError);
  });
});

describe('A5 two-session races on the execution row lock, gateway and orchestrator paths', () => {
  it('A5.1 cancellation wins: the gateway holds the lock, a completion waits on that PID, is refused, and reconciliation finalises', async () => {
    await drainDue();
    const s = new Scenario();
    try {
      const { executionId } = await startInvestigation(h, { tenantId: NORTH });
      const leaseFence = await holdLease(NORTH, executionId, `holder-a51-${executionId.slice(0, 8)}`);
      const reached = signal<number>();
      const proceed = barrier();
      s.track(proceed);
      const request = s.start(gatewayRequest(NORTH, executionId, { reached: reached.fire, proceed: proceed.promise }));
      const gatewayPid = await bounded(reached.promise, 'gateway request reached');
      const completion = s.start(withMessagingContext(h.pools.orchestrator, { tenantId: NORTH }, (client) =>
        createAgentExecutionStore(joinTransaction(client, NORTH), hooks).release(leaseFence, 'succeeded', 'completed')));
      expect(await waitBlockedBy(gatewayPid, 'agent_executions')).toBeGreaterThan(0);
      proceed.open();
      expect(await bounded(request, 'gateway request')).toMatchObject({ accepted: true, state: 'cancel_requested' });
      expect(await bounded(completion, 'completion')).toMatchObject({ ok: false, reason: 'cancel_requested' });
      await reconcile();
      expect(await state(executionId)).toMatchObject({ status: 'cancelled', cancel_requested: true, lease_agent_id: null });
      expect(await openGrants(executionId)).toBe(0);
      expect(await events(executionId, 'cancelled')).toBe(1);
      expect(await events(executionId, 'cancel_requested')).toBe(1);
    } finally {
      await s.close();
    }
  }, 60000);

  it('A5.2 completion wins: the completion holds the lock, the gateway request waits on that PID, and sees the terminal result', async () => {
    await drainDue();
    const s = new Scenario();
    try {
      const { executionId } = await startInvestigation(h, { tenantId: NORTH });
      const fence = await holdLease(NORTH, executionId, `holder-a52-${executionId.slice(0, 8)}`);
      const holding = signal<number>();
      const commit = barrier();
      s.track(commit);
      const completion = s.start(withMessagingContext(h.pools.orchestrator, { tenantId: NORTH }, async (client) => {
        const outcome = await createAgentExecutionStore(joinTransaction(client, NORTH), hooks).release(fence, 'succeeded', 'completed');
        holding.fire(await pidOf(client));
        await commit.promise;
        return outcome;
      }));
      const completionPid = await bounded(holding.promise, 'completion holding the lock');
      const request = s.start(gatewayRequest(NORTH, executionId));
      expect(await waitBlockedBy(completionPid, 'agent_executions')).toBeGreaterThan(0);
      commit.open();
      expect(await bounded(completion, 'completion')).toMatchObject({ ok: true });
      expect(await bounded(request, 'gateway request')).toMatchObject({ accepted: false, state: 'terminal' });
      expect(await state(executionId)).toMatchObject({ status: 'succeeded', cancel_requested: false, lease_agent_id: null });
      expect(await events(executionId, 'cancelled')).toBe(0);
      await reconcile();
      expect((await state(executionId)).status).toBe('succeeded');
    } finally {
      await s.close();
    }
  }, 60000);

  it('A5.3a request-grant consumption first (trigger-level, direct SQL): the cancellation waits on the consumer PID and is finalised', async () => {
    await drainDue();
    const s = new Scenario();
    try {
      const { executionId } = await startInvestigation(h, { tenantId: NORTH });
      const grant = await requestGrant(executionId);
      expect(grant).toBeDefined();
      const consumer = await s.client(h.adminPool);
      const consuming = signal();
      const commit = barrier();
      s.track(commit);
      const consumption = s.start((async () => {
        await consumer.query('BEGIN');
        await consumer.query(`UPDATE aegis.agent_grants SET status = 'consumed', consumed_at = clock_timestamp(), consumed_by_agent = 'triage',
            consumed_by_fencing_token = 0 WHERE grant_id = $1`, [grant.grant_id]);
        consuming.fire();
        await commit.promise;
        await consumer.query('COMMIT');
      })());
      await bounded(consuming.promise, 'consumption holding the grant');
      const consumerPid = await pidOf(consumer);
      const request = s.start(gatewayRequest(NORTH, executionId));
      await waitBlockedBy(consumerPid, 'agent_executions');
      commit.open();
      await bounded(consumption, 'consumption');
      expect(await bounded(request, 'gateway request')).toMatchObject({ accepted: true, state: 'cancel_requested' });
      // Reconcile explicitly before asserting terminal grant cleanup: a consumed grant is not revoked by a refused or waiting path.
      await reconcile();
      expect(await state(executionId)).toMatchObject({ status: 'cancelled' });
      expect((await h.adminPool.query<{ status: string }>('SELECT status FROM aegis.agent_grants WHERE grant_id = $1', [grant.grant_id])).rows[0].status)
        .toBe('consumed');
      expect(await openGrants(executionId)).toBe(0);
    } finally {
      await s.close();
    }
  }, 60000);

  it('A5.3b cancellation first (trigger-level, direct SQL): the committed request refuses consumption, and reconciliation then revokes the open grant', async () => {
    await drainDue();
    const s = new Scenario();
    try {
      const { executionId } = await pendingCancellation(NORTH, true);
      const grant = await requestGrant(executionId);
      expect(grant).toBeDefined();
      const consumer = await s.client(h.adminPool);
      await consumer.query('BEGIN');
      let code: string | null = null;
      try {
        await consumer.query(`UPDATE aegis.agent_grants SET status = 'consumed', consumed_at = clock_timestamp(), consumed_by_agent = 'triage',
            consumed_by_fencing_token = 0 WHERE grant_id = $1`, [grant.grant_id]);
        await consumer.query('COMMIT');
      } catch (error) {
        code = (error as { code?: string }).code ?? 'error';
        await consumer.query('ROLLBACK');
      }
      expect(code).toBe('42501');
      // The refusal consumes nothing and revokes nothing. The specific request grant stays open until the orchestrator finalises. The
      // aggregate is derived from the lifecycle: the leased execution holds this request grant and its result grant, both open.
      expect(await grantStatusOf(grant.grant_id)).toBe('open');
      expect(await openGrants(executionId)).toBeGreaterThanOrEqual(1);
      await reconcile();
      expect(await grantStatusOf(grant.grant_id)).toBe('revoked');
      expect(await openGrants(executionId)).toBe(0);
      expect(await state(executionId)).toMatchObject({ status: 'cancelled', lease_agent_id: null });
      expect(await events(executionId, 'cancelled')).toBe(1);
    } finally {
      await s.close();
    }
  }, 60000);

  it('A5.4 competing reconcilers: both discover one candidate; one holds its row lock before commit; the other queues behind that exact PID; exactly one applies', async () => {
    await drainDue();
    const s = new Scenario();
    const second = createDatabasePool(roleUrl('orchestrator'), 2);
    extraPools.push(second);
    try {
      const { executionId } = await pendingCancellation();
      // Gate 1, after discovery and before the row lock: both reconcilers are known to hold the same candidate.
      let arrivals = 0;
      const bothDiscovered = signal();
      const discoveryGate = s.track(barrier());
      const afterDiscovery = async (phase: 'finalise' | 'record') => {
        if (phase === 'finalise') {
          arrivals += 1;
          if (arrivals === 2) bothDiscovered.fire();
          await discoveryGate.promise;
        }
        return undefined;
      };
      // Gate 2, at the commit boundary of whichever reconciler takes the row lock first. That reconciler holds the lock, uncommitted.
      let holderClaimed = false;
      const holderPaused = signal();
      const commitGate = s.track(barrier());
      const holdingHooks = {
        beforeCommit: async (label: string) => {
          if (label === 'cancel_finalise:applied' && !holderClaimed) {
            holderClaimed = true;
            holderPaused.fire();
            await commitGate.promise;
          }
        },
      };
      const first = s.start(reconcileCancellations(h.pools.orchestrator, holdingHooks,
        { instance: 'instance-1', limit: 50, lockTimeoutMs: 15000, injectFault: afterDiscovery }));
      const other = s.start(reconcileCancellations(second, holdingHooks,
        { instance: 'instance-2', limit: 50, lockTimeoutMs: 15000, injectFault: afterDiscovery }));
      await bounded(bothDiscovered.promise, 'both reconcilers discovered the candidate');
      discoveryGate.open();
      await bounded(holderPaused.promise, 'one reconciler holds the execution row lock before commit');
      // The loser must be queued directly behind the holder: the blocking PID of its wait is the idle-in-transaction holder.
      const queued = await waitForQueuedBehindHolder('aegis.agent_executions');
      expect(queued.waiting).toBeGreaterThanOrEqual(1);
      commitGate.open();
      const [a, b] = await Promise.all([bounded(first, 'reconciler 1'), bounded(other, 'reconciler 2')]);
      expect([a.candidates, b.candidates]).toEqual([1, 1]);
      expect(a.applied + b.applied).toBe(1);
      expect(a.skipped + b.skipped).toBe(1);
      expect(a.systemic + b.systemic + a.unrecorded + b.unrecorded + a.transient + b.transient + a.deferred + b.deferred).toBe(0);
      expect(await events(executionId, 'cancelled')).toBe(1);
      expect(await state(executionId)).toMatchObject({ status: 'cancelled', lease_agent_id: null, attempts_cancel: 0, next_at: null, failure_class: null });
      expect(await generationOf(executionId)).toBe('0');
      expect(await openGrants(executionId)).toBe(0);
      // No revival: a further cycle finds nothing due and leaves the terminal state and its single event unchanged.
      expect((await reconcile()).candidates).toBe(0);
      expect(await state(executionId)).toMatchObject({ status: 'cancelled' });
      expect(await events(executionId, 'cancelled')).toBe(1);
    } finally {
      await s.close();
    }
  }, 60000);

  it('A5.5 opposing lock order: finalisation (execution, then grant) and participant consumption (grant, then execution) form a real cycle; PostgreSQL aborts one side', async () => {
    await drainDue();
    const s = new Scenario();
    try {
      const { executionId } = await pendingCancellation();
      const grant = await requestGrant(executionId);
      // The consumer is the participant login (aegis_triage), which holds UPDATE(status) on agent_grants (migration 018) and runs the
      // migration 023 trigger under its own identity. A committed cancellation request means that trigger refuses the consumption.
      const consumer = await s.client(h.pools.triage);
      const executionLocked = signal();
      const grantLocked = signal();
      const finalising = s.start(withMessagingContext(h.pools.orchestrator, { tenantId: NORTH }, async (client) => {
        await client.query('SELECT 1 FROM aegis.agent_executions WHERE execution_id = $1 FOR UPDATE', [executionId]);
        executionLocked.fire();
        await grantLocked.promise;
        await client.query(`UPDATE aegis.agent_grants SET status = 'revoked', revoked_at = clock_timestamp()
          WHERE execution_id = $1 AND status = 'open'`, [executionId]);
        return 'finalised';
      }));
      await bounded(executionLocked.promise, 'finalisation holds the execution row');
      await consumer.query('BEGIN');
      await consumer.query("SELECT set_config('aegis.tenant_id', $1, true)", [NORTH]);
      await consumer.query('SELECT 1 FROM aegis.agent_grants WHERE grant_id = $1 FOR UPDATE', [grant.grant_id]);
      grantLocked.fire();
      const consuming = s.start((async () => {
        await consumer.query(`UPDATE aegis.agent_grants SET status = 'consumed', consumed_at = clock_timestamp(), consumed_by_agent = 'triage',
            consumed_by_fencing_token = 0 WHERE grant_id = $1`, [grant.grant_id]);
        await consumer.query('COMMIT');
        return 'consumed';
      })());
      // Each side now waits on the other's lock. PostgreSQL detects the cycle and aborts exactly one side with SQLSTATE 40P01.
      const outcomes = await Promise.allSettled([bounded(finalising, 'finalisation', 30000), bounded(consuming, 'consumption', 30000)]);
      const codeOf = (o: PromiseSettledResult<unknown>): string => {
        if (o.status === 'fulfilled') return 'ok';
        const reason = o.reason as { code?: string; message?: string };
        return reason.code ?? reason.message ?? 'unknown';
      };
      const [finaliseOutcome, consumeOutcome] = outcomes.map(codeOf);
      expect(outcomes.filter((o) => o.status === 'rejected' && codeOf(o) === '40P01')).toHaveLength(1);
      if (consumeOutcome === '40P01') {
        // The consumer was the victim: the finalisation completed.
        expect(finaliseOutcome).toBe('ok');
      } else {
        // The finalisation was the victim: the consumer is then refused by the committed cancellation request, never consumed.
        expect(finaliseOutcome).toBe('40P01');
        expect(consumeOutcome).toBe('42501');
      }
      expect(consumeOutcome).not.toBe('ok');
      await consumer.query('ROLLBACK').catch(() => undefined);
      // Recovery: a reconciliation finalises whatever the aborted side left pending, and nothing is finalised twice.
      await reconcile();
      expect(await state(executionId)).toMatchObject({ status: 'cancelled', lease_agent_id: null });
      expect(await openGrants(executionId)).toBe(0);
      expect((await h.adminPool.query<{ status: string }>('SELECT status FROM aegis.agent_grants WHERE grant_id = $1', [grant.grant_id])).rows[0].status)
        .toBe('revoked');
      expect(await events(executionId, 'cancelled')).toBe(1);
    } finally {
      await s.close();
    }
  }, 90000);
});

describe('fixture isolation regression', () => {
  it('a cancellation deferred by a prior scenario is cleared by isolation and cannot change the next exact count', async () => {
    // The leak: a transient failure is recorded, so the cancellation is deferred and still pending when this test would end.
    const leaked = await pendingCancellation();
    expect(await reconcile({ injectFault: (phase, _t, id) => (phase === 'finalise' && id === leaked.executionId ? new Error('synthetic transient fault') : undefined) }))
      .toMatchObject({ candidates: 1, transient: 1 });
    expect(await isScheduledInFuture(leaked.executionId)).toBe(true);
    expect(await pendingCancellationCount(h)).toBe(1);
    // The isolation every test runs first clears it through the production reconciler, and nothing is left deferred.
    await isolateCancellationBacklog(h);
    expect(await pendingCancellationCount(h)).toBe(0);
    expect(await state(leaked.executionId)).toMatchObject({ status: 'cancelled', next_at: null });
    // The next scenario's exact count sees only its own cancellation.
    const fresh = await pendingCancellation();
    expect(await reconcile()).toMatchObject({ candidates: 1, applied: 1 });
    expect(await state(fresh.executionId)).toMatchObject({ status: 'cancelled' });
  }, 60000);
});

describe('A6 starvation, backoff, recovery and restart on real PostgreSQL', () => {
  it('A6.1 a poisoned cancellation ahead of a healthy one is rescheduled, and the healthy one completes in the next cycle', async () => {
    await drainDue();
    const poisoned = await pendingCancellation();
    const healthy = await pendingCancellation();
    const fault = (phase: 'finalise' | 'record', _t: string, id: string) =>
      phase === 'finalise' && id === poisoned.executionId ? new Error('synthetic transient fault') : undefined;
    expect(await reconcile({ limit: 1, injectFault: fault })).toMatchObject({ candidates: 1, transient: 1, applied: 0 });
    const afterFirst = await state(poisoned.executionId);
    expect(afterFirst).toMatchObject({ attempts_cancel: 1, failure_class: 'transient' });
    expect(await isScheduledInFuture(poisoned.executionId)).toBe(true);
    // The rescheduled cancellation is held out explicitly, so the next cycle must select the healthy one, whatever the wall clock is.
    await makeIneligible(poisoned.executionId);
    expect(await reconcile({ limit: 1, injectFault: fault })).toMatchObject({ candidates: 1, applied: 1 });
    expect((await state(healthy.executionId)).status).toBe('cancelled');
    expect((await reconcile({ limit: 1, injectFault: fault })).candidates).toBe(0);
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
      // A poisoned cancellation that has just failed is held out, so each cycle moves on to the next candidates (no wall-clock dependence).
      for (const id of poisoned) if ((await state(id)).attempts_cancel > 0) await makeIneligible(id);
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
    expect((await state(executionId)).attempts_cancel).toBe(1);
    expect(await isScheduledInFuture(executionId)).toBe(true);
    await makeIneligible(executionId);
    expect((await reconcile({ injectFault: fault })).candidates).toBe(0);
    await makeDue(executionId);
    await reconcile({ injectFault: fault });
    expect((await state(executionId)).attempts_cancel).toBe(2);
    // Test-only persisted state near saturation. The three retry fields are set together, as the table's CHECK requires.
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
    expect(await reconcile({ injectFault: crash })).toMatchObject({ unrecorded: 1, halted: true });
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
    expect(await isScheduledInFuture(executionId)).toBe(true);
    await makeIneligible(executionId);
    const restarted = createDatabasePool(roleUrl('orchestrator'), 2);
    extraPools.push(restarted);
    try {
      expect(await reconcile({}, restarted)).toMatchObject({ candidates: 0 });
      await makeDue(executionId);
      expect(await reconcile({}, restarted)).toMatchObject({ applied: 1 });
    } finally {
      await restarted.end();
      extraPools.splice(extraPools.indexOf(restarted), 1);
    }
  }, 60000);

  it('A6.7 lock-aware discovery: a full batch of locked executions does not occupy the batch, and healthy work completes while the locks are held', async () => {
    await drainDue();
    const s = new Scenario();
    try {
      const locked: string[] = [];
      for (let i = 0; i < 10; i += 1) locked.push((await pendingCancellation()).executionId);
      const healthy = (await pendingCancellation()).executionId;
      const holder = await s.client(h.adminPool);
      await holder.query('BEGIN');
      await holder.query('SELECT 1 FROM aegis.agent_executions WHERE execution_id = ANY($1::uuid[]) FOR UPDATE', [locked]);
      try {
        const summary = await reconcile({ limit: 10 });
        expect(summary).toMatchObject({ candidates: 1, applied: 1, deferred: 0, halted: false });
        expect((await state(healthy)).status).toBe('cancelled');
        expect(await reconcile({ limit: 10 })).toMatchObject({ candidates: 0 });
      } finally {
        await holder.query('ROLLBACK');
      }
      // After release, the previously locked cancellations are discovered and finalised.
      let cycles = 0;
      while (cycles < 5 && (await Promise.all(locked.map(async (id) => (await state(id)).status))).some((st) => st !== 'cancelled')) {
        cycles += 1;
        await reconcile({ limit: 10 });
      }
      expect(cycles).toBeLessThanOrEqual(1);
      for (const id of locked) expect((await state(id)).status).toBe('cancelled');
    } finally {
      await s.close();
    }
  }, 90000);

  it('A6.8 more than one batch locked: healthy work completes while the locks are held, across several cycles', async () => {
    await drainDue();
    const s = new Scenario();
    try {
      const locked: string[] = [];
      for (let i = 0; i < 25; i += 1) locked.push((await pendingCancellation()).executionId);
      const healthy = [(await pendingCancellation()).executionId, (await pendingCancellation()).executionId];
      const holder = await s.client(h.adminPool);
      await holder.query('BEGIN');
      await holder.query('SELECT 1 FROM aegis.agent_executions WHERE execution_id = ANY($1::uuid[]) FOR UPDATE', [locked]);
      try {
        for (let cycle = 0; cycle < 3; cycle += 1) await reconcile({ limit: 10 });
        for (const id of healthy) expect((await state(id)).status).toBe('cancelled');
        for (const id of locked) expect((await state(id)).status).toBe('pending');
      } finally {
        await holder.query('ROLLBACK');
      }
      let cycles = 0;
      while (cycles < 6 && (await Promise.all(locked.map(async (id) => (await state(id)).status))).some((st) => st !== 'cancelled')) {
        cycles += 1;
        await reconcile({ limit: 10 });
      }
      for (const id of locked) expect((await state(id)).status).toBe('cancelled');
    } finally {
      await s.close();
    }
  }, 120000);

  it('A6.9 a locked execution does not block unrelated cancellations and is not recorded as failed', async () => {
    await drainDue();
    const s = new Scenario();
    try {
      const locked = await pendingCancellation();
      const healthy = await pendingCancellation();
      const holder = await s.client(h.adminPool);
      await holder.query('BEGIN');
      await holder.query('SELECT 1 FROM aegis.agent_executions WHERE execution_id = $1 FOR UPDATE', [locked.executionId]);
      try {
        expect(await reconcile({ lockTimeoutMs: 300 })).toMatchObject({ deferred: 0, halted: false });
        expect((await state(healthy.executionId)).status).toBe('cancelled');
        expect((await state(locked.executionId)).attempts_cancel).toBe(0);
      } finally {
        await holder.query('ROLLBACK');
      }
      expect(await reconcile()).toMatchObject({ applied: 1 });
    } finally {
      await s.close();
    }
  }, 60000);

  it('A6.10 retry generation: duplicate and stale failures are refused by the generation, and a finalised cancellation takes no later failure', async () => {
    await drainDue();
    const { executionId } = await pendingCancellation();
    const record = (expectedGeneration: string) => withMessagingContext(h.pools.orchestrator, { tenantId: NORTH }, (client) =>
      createAgentExecutionStore(joinTransaction(client, NORTH), hooks).recordCancellationFailure(NORTH, executionId, 'transient', expectedGeneration));
    expect(await generationOf(executionId)).toBe('0');
    // The first failure from discovery generation 0 is recorded and advances the generation to 1.
    expect(await record('0')).toMatchObject({ recorded: true, attempts: 1 });
    expect(await generationOf(executionId)).toBe('1');
    const scheduled = (await state(executionId)).next_at!.getTime();
    // A duplicate from the same discovery generation (0) is refused and changes nothing.
    expect(await record('0')).toMatchObject({ recorded: false });
    expect((await state(executionId)).next_at!.getTime()).toBe(scheduled);
    expect((await state(executionId)).attempts_cancel).toBe(1);
    // A reconciler that discovered generation 1 records, then a stale holder of generation 1 is refused.
    await makeDue(executionId);
    expect(await record('1')).toMatchObject({ recorded: true, attempts: 2 });
    expect(await record('1')).toMatchObject({ recorded: false });
    expect(await generationOf(executionId)).toBe('2');
    // A later reconciler finalises. A stale failure arriving after that must change nothing.
    await makeDue(executionId);
    expect(await reconcile()).toMatchObject({ applied: 1 });
    expect(await record('2')).toMatchObject({ recorded: false });
    expect(await state(executionId)).toMatchObject({ status: 'cancelled', attempts_cancel: 2, next_at: null });
    expect(await events(executionId, 'cancelled')).toBe(1);
  }, 60000);

  it('A6.11 concurrent failures at attempt 999 and at saturated attempt 1000: one wins per generation, the count stays at 1000, and retries continue', async () => {
    await drainDue();
    // The backlog is shared across tenants and may hold deferred work from other tests. Its assertions use deltas from a baseline taken
    // before this test creates anything, and the execution is anchored to this test.
    const baseline = await readCancellationBacklog(h.pools.orchestrator);
    const { executionId } = await pendingCancellation();
    try {
    const record = (expectedGeneration: string) => withMessagingContext(h.pools.orchestrator, { tenantId: NORTH }, (client) =>
      createAgentExecutionStore(joinTransaction(client, NORTH), hooks).recordCancellationFailure(NORTH, executionId, 'transient', expectedGeneration));
    // Concurrency at 999: two reconcilers hold the same generation 5. The row lock serialises them; the second re-evaluates and is refused.
    await setRetryState(executionId, 999, '5');
    const at999 = await Promise.all([bounded(record('5'), 'failure A at 999'), bounded(record('5'), 'failure B at 999')]);
    expect(at999.filter((r) => r.recorded)).toHaveLength(1);
    expect(await state(executionId)).toMatchObject({ attempts_cancel: 1000 });
    expect(await generationOf(executionId)).toBe('6');
    // Concurrency at saturated 1000: both hold generation 6. The attempt count cannot exceed 1000, and only one generation advances.
    const saturated = await Promise.all([bounded(record('6'), 'failure A at 1000'), bounded(record('6'), 'failure B at 1000')]);
    expect(saturated.filter((r) => r.recorded)).toHaveLength(1);
    expect(await state(executionId)).toMatchObject({ attempts_cancel: 1000 });
    expect(await generationOf(executionId)).toBe('7');
    // Backoff after saturation stays at the 60 second cap, not at an overflowed or reset value.
    const after = await state(executionId);
    expect(after.next_at!.getTime() - after.last_at!.getTime()).toBeGreaterThan(59000);
    expect(after.next_at!.getTime() - after.last_at!.getTime()).toBeLessThanOrEqual(61000);
    // No silent abandonment: a saturated cancellation stays visible in the backlog and is retried on each due cycle.
    const during = await readCancellationBacklog(h.pools.orchestrator);
    expect(during.pending - baseline.pending).toBe(1);
    expect(during.failing - baseline.failing).toBe(1);
    expect(during.maxAttempts).toBeGreaterThanOrEqual(1000);
    await makeDue(executionId);
    expect(await record('7')).toMatchObject({ recorded: true, attempts: 1000 });
    expect(await generationOf(executionId)).toBe('8');
    expect(await reconcile()).toMatchObject({ candidates: 0 });
    await makeDue(executionId);
    expect((await reconcile()).candidates).toBe(1);
    expect(await state(executionId)).toMatchObject({ status: 'cancelled' });
    expect(await events(executionId, 'cancelled')).toBe(1);
    } finally {
      // A failed assertion must not leave this test's cancellation pending for later tests: finalise it if it is still pending.
      await h.adminPool.query(`UPDATE aegis.agent_executions SET cancellation_next_attempt_at = clock_timestamp() - interval '1 second'
        WHERE execution_id = $1 AND cancel_requested AND status NOT IN ('succeeded', 'failed', 'cancelled')`, [executionId]).catch(() => undefined);
      await reconcile().catch(() => undefined);
    }
  }, 60000);

  it('A6.11b a generation that is not a canonical bigint is refused before it reaches the database', async () => {
    const { executionId } = await pendingCancellation();
    const attempt = (expectedGeneration: string) => withMessagingContext(h.pools.orchestrator, { tenantId: NORTH }, (client) =>
      createAgentExecutionStore(joinTransaction(client, NORTH), hooks).recordCancellationFailure(NORTH, executionId, 'transient', expectedGeneration));
    await expect(attempt('-1')).rejects.toBeInstanceOf(RangeError);
    await expect(attempt('01')).rejects.toBeInstanceOf(RangeError);
    await expect(attempt('9999999999999999999')).rejects.toBeInstanceOf(RangeError); // 19 digits: refused before the database
    await expect(attempt('999999999999999999')).resolves.toMatchObject({ recorded: false }); // 18 digits: valid, not the current generation
    expect(await generationOf(executionId)).toBe('0');
  }, 60000);

  it('A6.12 participants cannot discover cancellations, read the backlog, or write retry state', async () => {
    const triage = (sql: string) => withMessagingContext(h.pools.triage, { tenantId: NORTH }, (client) => client.query(sql, []));
    await expect(triage('SELECT * FROM aegis.orchestrator_due_cancellations(10)')).rejects.toThrow(/permission denied/);
    await expect(triage('SELECT * FROM aegis.orchestrator_cancellation_backlog()')).rejects.toThrow(/permission denied/);
    await expect(triage('UPDATE aegis.agent_executions SET cancellation_attempts = 0')).rejects.toThrow(/permission denied/);
    await expect(triage('UPDATE aegis.agent_executions SET cancellation_next_attempt_at = NULL')).rejects.toThrow(/permission denied/);
  }, 60000);

  it('A6.13 cross-tenant isolation: a SOUTH cancellation is not finalised under a NORTH context', async () => {
    const { executionId } = await pendingCancellation(SOUTH);
    const result = await withMessagingContext(h.pools.orchestrator, { tenantId: NORTH }, (client) =>
      createAgentExecutionStore(joinTransaction(client, NORTH), hooks).finaliseCancellation(NORTH, executionId, 'wrong-tenant'));
    expect(result).toMatchObject({ ok: false, reason: 'not_found' });
    expect((await state(executionId)).status).toBe('pending');
    await reconcile();
    expect((await state(executionId)).status).toBe('cancelled');
  }, 60000);

  it('A6.14 backlog visibility exposes counts and ages only, and reports a failing cancellation', async () => {
    await drainDue();
    const { executionId } = await pendingCancellation();
    await reconcile({ injectFault: (phase, _t, id) => phase === 'finalise' && id === executionId ? new Error('synthetic') : undefined });
    const backlog = await readCancellationBacklog(h.pools.orchestrator);
    expect(backlog.failing).toBeGreaterThanOrEqual(1);
    expect(backlog.maxAttempts).toBeGreaterThanOrEqual(1);
    expect(Object.keys(backlog).sort()).toEqual(['failing', 'maxAttempts', 'oldestRequestAgeSeconds', 'overdue', 'pending']);
    await reconcile();
  }, 60000);
});

describe('connection lifecycle regression', () => {
  it('a held execution lock does not hold pool connections: the admin pool has no waiters and a new connection is available afterwards', async () => {
    const s = new Scenario();
    try {
      const { executionId } = await pendingCancellation();
      const holder = await s.client(h.adminPool);
      await holder.query('BEGIN');
      await holder.query('SELECT 1 FROM aegis.agent_executions WHERE execution_id = $1 FOR UPDATE', [executionId]);
      // Discovery skips a locked execution, so a contending reconciler returns at once instead of waiting on a connection.
      expect(await reconcile({ lockTimeoutMs: 300 })).toMatchObject({ candidates: 0 });
    } finally {
      await s.close();
    }
    expect(h.adminPool.waitingCount).toBe(0);
    await expect(h.adminPool.query('SELECT 1 AS ok')).resolves.toMatchObject({ rows: [{ ok: 1 }] });
  }, 60000);
});

void SOUTH;

describe('interrupted lock-contention cleanup', () => {
  it('cleanup of an interrupted scenario releases the uncommitted blocker and restores connection availability', async () => {
    await drainDue();
    const s = new Scenario();
    try {
      const { executionId } = await startInvestigation(h, { tenantId: NORTH });
      const blocker = await s.client(h.adminPool);
      await blocker.query('BEGIN');
      await blocker.query('SELECT 1 FROM aegis.agent_executions WHERE execution_id = $1 FOR UPDATE', [executionId]);
      const blockerPid = await pidOf(blocker);
      // A waiter that cannot proceed while the blocker holds the row. The interruption below must free it.
      const waiter = s.start(withMessagingContext(h.pools.orchestrator, { tenantId: NORTH }, (client) =>
        client.query('SELECT 1 FROM aegis.agent_executions WHERE execution_id = $1 FOR UPDATE', [executionId])));
      await waitingOn(blockerPid, 'agent_executions', 1);
      // Interrupt while the blocker is still an open, uncommitted transaction.
      await bounded(s.close(), 'interrupted scenario cleanup', 30000);
      await expect(bounded(waiter, 'waiter after cleanup', 5000)).resolves.toBeDefined();
      const alive = await h.adminPool.query<{ n: string }>('SELECT count(*)::text AS n FROM pg_stat_activity WHERE pid = $1', [blockerPid]);
      expect(Number(alive.rows[0].n)).toBe(0);
      const queued = await h.adminPool.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND query ILIKE '%agent_executions%'`);
      expect(Number(queued.rows[0].n)).toBe(0);
      expect(h.adminPool.waitingCount).toBe(0);
      const probe = await bounded(h.adminPool.query<{ ok: number }>('SELECT 1 AS ok'), 'connection availability after cleanup', 5000);
      expect(probe.rows[0].ok).toBe(1);
      expect(await state(executionId)).toMatchObject({ cancel_requested: false });
    } finally {
      await s.close();
    }
  }, 60000);
});

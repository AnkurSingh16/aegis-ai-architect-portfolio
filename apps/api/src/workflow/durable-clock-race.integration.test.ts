import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { createDatabasePool } from '../storage/database.js';
import { migrateDatabase } from '../storage/migrations.js';
import type { TenantQueryable } from '../security/tool-approval-store.js';
import { createDurableStore } from './durable-store.js';
import { runDurableAttempt } from './durable-driver.js';

// Real PostgreSQL checks for: worker clock skew (lease and retry times come from the database), a reproducible
// cancellation race (the case that was previously found by code inspection), concurrent claims, and lost-attempt recovery.
const adminUrl = process.env.TEST_DATABASE_ADMIN_URL;
const runtimeUrl = process.env.TEST_DATABASE_URL;
if (!adminUrl || !runtimeUrl) throw new Error('Set TEST_DATABASE_ADMIN_URL and TEST_DATABASE_URL for real PostgreSQL tests.');

const admin = new Pool({ connectionString: adminUrl, max: 2 });
const pool = createDatabasePool(runtimeUrl, 6);
const tenant = randomUUID();
const policy = { maxAttempts: 3, baseDelayMs: 1000, maxDelayMs: 4000 };
const DAY_MS = 24 * 60 * 60 * 1000;

const runTenant = async <T>(tenantId: string, operation: (client: TenantQueryable) => Promise<T>): Promise<T> => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('aegis.tenant_id', $1, true)", [tenantId]);
    const result = await operation(client as unknown as TenantQueryable);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
};

const store = createDurableStore(runTenant);
/** A worker whose own clock is offset by `skewMs` from real time. Lease and retry times still come from the database. */
function worker(executionId: string, owner: string, skewMs: number, step: () => Promise<void>, nowRef = { skew: skewMs }) {
  return {
    store, executionId, tenantId: tenant, owner, policy, leaseMs: 5000, timeoutMs: 2000,
    clock: () => new Date(Date.now() + nowRef.skew), databaseTime: (t: string) => store.databaseNow(t),
    step: async () => step(),
  };
}

beforeAll(async () => {
  await migrateDatabase(adminUrl, process.env.DATABASE_APP_PASSWORD ?? '', process.env.DATABASE_INGEST_PASSWORD ?? '');
  await admin.query("INSERT INTO aegis.tenants (id, name) VALUES ($1, 'Synthetic North')", [tenant]);
});

afterAll(async () => {
  await Promise.all([pool.end(), admin.end()]);
});

describe('worker clock skew does not change lease or retry decisions', () => {
  it('a worker whose clock is a day ahead still completes its own attempt', async () => {
    const { executionId } = await store.createExecution(tenant, `skew-ahead-${randomUUID()}`, 3);
    const outcome = await runDurableAttempt(worker(executionId, 'ahead', DAY_MS, async () => undefined));
    expect(outcome).toEqual({ status: 'succeeded', attempt: 1 });
    expect((await store.load(executionId, tenant))?.execution.state).toBe('succeeded');
  });

  it('a worker a day behind cannot take a lease that the database says is held', async () => {
    const { executionId } = await store.createExecution(tenant, `skew-held-${randomUUID()}`, 3);
    let inner: Awaited<ReturnType<typeof runDurableAttempt>> | undefined;
    const outcome = await runDurableAttempt(worker(executionId, 'holder', 0, async () => {
      // While the holder's attempt is in flight, a worker with a clock a day behind must find the lease held.
      inner = await runDurableAttempt(worker(executionId, 'behind', -DAY_MS, async () => undefined));
    }));
    expect(inner).toEqual({ status: 'not_claimable' });
    expect(outcome).toEqual({ status: 'succeeded', attempt: 1 });
  });

  it('retry times are set from the database clock, not from a worker clock a day ahead', async () => {
    const { executionId } = await store.createExecution(tenant, `skew-retry-${randomUUID()}`, 3);
    const before = await store.databaseNow(tenant);
    const outcome = await runDurableAttempt(worker(executionId, 'ahead', DAY_MS, async () => {
      throw Object.assign(new Error('upstream reset'), { code: 'ECONNRESET' });
    }));
    expect(outcome.status).toBe('retry_scheduled');
    const nextAttemptAt = (outcome as { nextAttemptAt: Date }).nextAttemptAt.getTime();
    expect(nextAttemptAt - before.getTime()).toBeLessThan(60_000);
    expect(nextAttemptAt - before.getTime()).toBeGreaterThanOrEqual(0);
  });
});

describe('the cancellation race that was previously found by inspection', () => {
  it('records the request when another writer moves the execution between the read and the write', async () => {
    const { executionId } = await store.createExecution(tenant, `race-${randomUUID()}`, 3);
    // The hook runs after the cancellation has read the row and before it writes. The concurrent writer bumps the version,
    // so the conditional cancel matches no row. Before the fix, the request was then silently dropped.
    const racing = createDurableStore(runTenant, {
      afterCancelRead: async () => {
        await admin.query('UPDATE aegis.workflow_executions SET version = version + 1 WHERE execution_id = $1', [executionId]);
      },
    });
    expect(await racing.requestCancel(executionId, tenant, new Date(), 'operator-a', 'customer withdrew')).toBe('cancel_requested');
    const loaded = await store.load(executionId, tenant);
    expect(loaded?.execution.cancelRequested).toBe(true);
    expect(loaded?.execution.cancelRequestedBy).toBe('operator-a');
    expect(loaded?.execution.cancelReason).toBe('customer withdrew');
  });

  it('a driver honours a request that arrived through that race, instead of running the step', async () => {
    const { executionId } = await store.createExecution(tenant, `race-driver-${randomUUID()}`, 3);
    const racing = createDurableStore(runTenant, {
      afterCancelRead: async () => {
        await admin.query('UPDATE aegis.workflow_executions SET version = version + 1 WHERE execution_id = $1', [executionId]);
      },
    });
    await racing.requestCancel(executionId, tenant, new Date(), 'operator-a', 'customer withdrew');
    let steps = 0;
    const outcome = await runDurableAttempt({ ...worker(executionId, 'w', 0, async () => { steps += 1; }) });
    expect(outcome).toEqual({ status: 'cancelled', reason: 'requested' });
    expect(steps).toBe(0);
  });
});

describe('concurrent claims and recovery', () => {
  it('two workers racing for the same execution run its step exactly once', async () => {
    const { executionId } = await store.createExecution(tenant, `concurrent-${randomUUID()}`, 3);
    let steps = 0;
    const step = async () => { steps += 1; await new Promise((resolve) => setTimeout(resolve, 20)); };
    const [a, b] = await Promise.all([
      runDurableAttempt(worker(executionId, 'worker-a', 0, step)),
      runDurableAttempt(worker(executionId, 'worker-b', 0, step)),
    ]);
    expect(steps).toBe(1);
    expect([a.status, b.status].sort()).toEqual(['not_claimable', 'succeeded']);
  });

  it('recovers an attempt whose worker died while holding the lease', async () => {
    const { executionId } = await store.createExecution(tenant, `recover-${randomUUID()}`, 3);
    const now = await store.databaseNow(tenant);
    // A worker claims, starts the attempt (state running, as the driver does) and then dies with its lease still held.
    const leaseExpiresAt = new Date(now.getTime() + 500);
    const claimed = await store.claim(executionId, tenant, 'dead-worker', now, leaseExpiresAt);
    expect(claimed).not.toBeNull();
    await store.transition({ executionId, tenantId: tenant, owner: 'dead-worker', expectedVersion: claimed!.version, state: 'running',
      attempts: 1, nextAttemptAt: null, lastErrorClass: null, keepLease: true, leaseExpiresAt, now,
      approval: { kind: 'keep' } });
    await new Promise((resolve) => setTimeout(resolve, 700));
    const outcome = await runDurableAttempt(worker(executionId, 'recovering', 0, async () => undefined));
    expect(outcome.status).toBe('lost_attempt_recovered');
  });
});

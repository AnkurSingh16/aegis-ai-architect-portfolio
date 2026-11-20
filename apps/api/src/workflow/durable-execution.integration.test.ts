import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { createDatabasePool } from '../storage/database.js';
import { migrateDatabase } from '../storage/migrations.js';
import type { TenantQueryable } from '../security/tool-approval-store.js';
import { createDurableStore } from './durable-store.js';
import { type DriverLogRecord, runDurableAttempt } from './durable-driver.js';

// Real PostgreSQL checks for migration 008 and the durable execution driver.
const adminUrl = process.env.TEST_DATABASE_ADMIN_URL;
const runtimeUrl = process.env.TEST_DATABASE_URL;
if (!adminUrl || !runtimeUrl) throw new Error('Set TEST_DATABASE_ADMIN_URL and TEST_DATABASE_URL for real PostgreSQL tests.');

const admin = new Pool({ connectionString: adminUrl, max: 1 });
const pool = createDatabasePool(runtimeUrl, 6);
const tenantA = randomUUID();
const tenantB = randomUUID();
const policy = { maxAttempts: 3, baseDelayMs: 1000, maxDelayMs: 4000 };

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
const at = (ms: number) => new Date(Date.UTC(2026, 10, 19, 10, 0, 0) + ms);

function driver(executionId: string, tenantId: string, owner: string, clockMs: { now: number }, step: (attempt: number) => Promise<void>) {
  return {
    store, executionId, tenantId, owner, policy, leaseMs: 5000, timeoutMs: 2000,
    clock: () => at(clockMs.now),
    step: (attempt: number) => step(attempt),
  };
}

beforeAll(async () => {
  // Idempotent: applies only pending migrations, so this file does not depend on test file order.
  await migrateDatabase(adminUrl, process.env.DATABASE_APP_PASSWORD ?? '', process.env.DATABASE_INGEST_PASSWORD ?? '');
  await admin.query("INSERT INTO aegis.tenants (id, name) VALUES ($1, 'Synthetic North'), ($2, 'Synthetic South')", [tenantA, tenantB]);
});

afterAll(async () => {
  await pool.end();
  await admin.end();
});

describe('durable execution in real PostgreSQL', () => {
  it('creates idempotently: the same key returns the same execution', async () => {
    const key = `key-${randomUUID()}`;
    const first = await store.createExecution(tenantA, key, 3);
    const second = await store.createExecution(tenantA, key, 3);
    expect(first.created).toBe(true);
    expect(second).toEqual({ executionId: first.executionId, created: false });
  });

  it('runs a successful execution and records each checkpoint in order', async () => {
    const { executionId } = await store.createExecution(tenantA, `ok-${randomUUID()}`, 3);
    const clock = { now: 0 };
    const outcome = await runDurableAttempt(driver(executionId, tenantA, 'worker-1', clock, async () => undefined));
    expect(outcome).toEqual({ status: 'succeeded', attempt: 1 });
    const loaded = await store.load(executionId, tenantA);
    expect(loaded?.execution.state).toBe('succeeded');
    expect(loaded?.checkpoints.map((c) => [c.seq, c.state, c.attempts])).toEqual([[1, 'running', 1], [2, 'succeeded', 1]]);
  });

  it('retries a transient failure after its delay and succeeds on the next attempt', async () => {
    const { executionId } = await store.createExecution(tenantA, `retry-${randomUUID()}`, 3);
    const clock = { now: 0 };
    const flaky = async (attempt: number) => {
      if (attempt === 1) throw Object.assign(new Error('upstream reset'), { code: 'ECONNRESET' });
    };
    expect(await runDurableAttempt(driver(executionId, tenantA, 'worker-1', clock, flaky)))
      .toEqual({ status: 'retry_scheduled', attempt: 1, nextAttemptAt: at(1000) });
    // Not due yet: nothing can be claimed.
    expect(await runDurableAttempt(driver(executionId, tenantA, 'worker-1', { now: 500 }, flaky))).toEqual({ status: 'not_claimable' });
    expect(await runDurableAttempt(driver(executionId, tenantA, 'worker-1', { now: 1000 }, flaky))).toEqual({ status: 'succeeded', attempt: 2 });
  });

  it('stops after the attempt budget is exhausted', async () => {
    const { executionId } = await store.createExecution(tenantA, `exhaust-${randomUUID()}`, 2);
    const always = async () => { throw Object.assign(new Error('down'), { code: 'ETIMEDOUT' }); };
    expect((await runDurableAttempt(driver(executionId, tenantA, 'w', { now: 0 }, always))).status).toBe('retry_scheduled');
    expect(await runDurableAttempt(driver(executionId, tenantA, 'w', { now: 10_000 }, always)))
      .toEqual({ status: 'failed', attempt: 2, errorClass: 'retryable' });
    expect((await store.load(executionId, tenantA))?.execution.state).toBe('failed');
  });

  it('fails permanently without retrying a non-transient error', async () => {
    const { executionId } = await store.createExecution(tenantA, `perm-${randomUUID()}`, 3);
    expect(await runDurableAttempt(driver(executionId, tenantA, 'w', { now: 0 }, async () => { throw new Error('invalid input'); })))
      .toEqual({ status: 'failed', attempt: 1, errorClass: 'permanent' });
  });

  it('recovers after a crash mid-attempt: the lost attempt counts and a later worker resumes', async () => {
    const { executionId } = await store.createExecution(tenantA, `crash-${randomUUID()}`, 3);
    // Worker A records the start of attempt 1, then dies without finishing or releasing its lease.
    const claimed = await store.claim(executionId, tenantA, 'worker-A', at(0), at(5000));
    expect(claimed).not.toBeNull();
    await store.transition({ executionId, tenantId: tenantA, owner: 'worker-A', expectedVersion: claimed!.version, state: 'running',
      attempts: 1, nextAttemptAt: null, lastErrorClass: null, keepLease: true, leaseExpiresAt: at(5000), now: at(0) });
    // While the lease is live, worker B cannot touch it.
    expect(await runDurableAttempt(driver(executionId, tenantA, 'worker-B', { now: 1000 }, async () => undefined))).toEqual({ status: 'not_claimable' });
    // After expiry, worker B recovers the lost attempt, then runs the next attempt.
    const recovered = await runDurableAttempt(driver(executionId, tenantA, 'worker-B', { now: 6000 }, async () => undefined));
    expect(recovered.status).toBe('lost_attempt_recovered');
    expect(await runDurableAttempt(driver(executionId, tenantA, 'worker-B', { now: 6000 }, async () => undefined)))
      .toEqual({ status: 'succeeded', attempt: 2 });
    const loaded = await store.load(executionId, tenantA);
    expect(loaded?.checkpoints.map((c) => c.seq)).toEqual(loaded?.checkpoints.map((_, i) => i + 1));
    expect(loaded?.execution.state).toBe('succeeded');
  });

  it('lets exactly one of two concurrent claimants win', async () => {
    const { executionId } = await store.createExecution(tenantA, `race-${randomUUID()}`, 3);
    const [a, b] = await Promise.all([
      store.claim(executionId, tenantA, 'worker-1', at(0), at(5000)),
      store.claim(executionId, tenantA, 'worker-2', at(0), at(5000)),
    ]);
    expect([a, b].filter((row) => row !== null)).toHaveLength(1);
  });

  it('rejects a stale writer whose version no longer matches', async () => {
    const { executionId } = await store.createExecution(tenantA, `stale-${randomUUID()}`, 3);
    const claimed = await store.claim(executionId, tenantA, 'worker-1', at(0), at(5000));
    await store.transition({ executionId, tenantId: tenantA, owner: 'worker-1', expectedVersion: claimed!.version, state: 'running',
      attempts: 1, nextAttemptAt: null, lastErrorClass: null, keepLease: true, leaseExpiresAt: at(5000), now: at(0) });
    await expect(store.transition({ executionId, tenantId: tenantA, owner: 'worker-1', expectedVersion: claimed!.version, state: 'succeeded',
      attempts: 1, nextAttemptAt: null, lastErrorClass: null, keepLease: false, leaseExpiresAt: at(5000), now: at(1) }))
      .rejects.toThrow(/stale/);
  });

  it('hides executions from other tenants', async () => {
    const { executionId } = await store.createExecution(tenantA, `iso-${randomUUID()}`, 3);
    expect(await store.load(executionId, tenantB)).toBeUndefined();
    expect(await store.claim(executionId, tenantB, 'worker-x', at(0), at(5000))).toBeNull();
  });

  it('keeps checkpoints append-only for the application role', async () => {
    const { executionId } = await store.createExecution(tenantA, `append-${randomUUID()}`, 3);
    await runDurableAttempt(driver(executionId, tenantA, 'w', { now: 0 }, async () => undefined));
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('aegis.tenant_id', $1, true)", [tenantA]);
      await expect(client.query('UPDATE aegis.workflow_checkpoints SET state = $2 WHERE execution_id = $1', [executionId, 'failed']))
        .rejects.toThrow();
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
  });

  it('logs one record per call with ids and the outcome, and never the error message', async () => {
    const records: DriverLogRecord[] = [];
    const { executionId } = await store.createExecution(tenantA, `log-${randomUUID()}`, 3);
    const base = driver(executionId, tenantA, 'w', { now: 0 }, async () => { throw new Error('payload SENTINEL-LOG-1'); });
    const outcome = await runDurableAttempt({ ...base, log: (record) => { records.push(record); }, correlationId: 'corr-driver-1' });
    expect(outcome).toEqual({ status: 'failed', attempt: 1, errorClass: 'permanent' });
    expect(records).toEqual([{
      event: 'durable_attempt', executionId, correlationId: 'corr-driver-1', outcome: 'failed', attempt: 1, errorClass: 'permanent',
    }]);
    expect(JSON.stringify(records)).not.toContain('SENTINEL-LOG-1');
  });

  it('keeps the committed outcome when the logger throws', async () => {
    const { executionId } = await store.createExecution(tenantA, `logthrow-${randomUUID()}`, 3);
    const base = driver(executionId, tenantA, 'w', { now: 0 }, async () => undefined);
    const outcome = await runDurableAttempt({ ...base, log: () => { throw new Error('log sink unavailable'); }, correlationId: null });
    expect(outcome).toEqual({ status: 'succeeded', attempt: 1 });
    expect((await store.load(executionId, tenantA))?.execution.state).toBe('succeeded');
  });
});

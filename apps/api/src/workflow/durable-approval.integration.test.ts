import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { createDatabasePool } from '../storage/database.js';
import { migrateDatabase } from '../storage/migrations.js';
import { createPostgresApprovalStore, type TenantQueryable } from '../security/tool-approval-store.js';
import { createDurableStore } from './durable-store.js';
import { type ApprovalGate, resumeApprovalWait, runDurableAttempt } from './durable-driver.js';

// Real PostgreSQL checks for approval waits, cancellation, and the approval gate in the durable driver.
const adminUrl = process.env.TEST_DATABASE_ADMIN_URL;
const runtimeUrl = process.env.TEST_DATABASE_URL;
if (!adminUrl || !runtimeUrl) throw new Error('Set TEST_DATABASE_ADMIN_URL and TEST_DATABASE_URL for real PostgreSQL tests.');

const admin = new Pool({ connectionString: adminUrl, max: 1 });
const pool = createDatabasePool(runtimeUrl, 6);
const tenantA = randomUUID();
const tenantB = randomUUID();
const policy = { maxAttempts: 3, baseDelayMs: 1000, maxDelayMs: 4000 };
const at = (ms: number) => new Date(Date.UTC(2026, 10, 19, 10, 0, 0) + ms);

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
const approvals = createPostgresApprovalStore(runTenant);

/** Gate backed by the tool approval store, using the same clock as the driver. */
function gateFor(tenantId: string, clock: () => Date): ApprovalGate {
  return {
    createApproval: () => approvals.create({
      tenantId, toolName: 'case.close', actionDigest: 'a'.repeat(64), requestedBy: 'user-1', expiresAt: new Date(clock().getTime() + 3_600_000),
    }),
    status: async (approvalId) => {
      const record = await approvals.get(approvalId, tenantId);
      if (!record) return 'rejected';
      if (record.status === 'approved') return record.expiresAt.getTime() <= clock().getTime() ? 'expired' : 'approved';
      if (record.status === 'pending') return 'pending';
      if (record.status === 'consumed') return 'consumed';
      return 'rejected';
    },
    consume: (approvalId) => approvals.consume(approvalId, tenantId, clock()),
  };
}

function drive(executionId: string, tenantId: string, clockMs: { now: number }, step: (attempt: number, signal: AbortSignal) => Promise<void>, gate?: ApprovalGate) {
  return {
    store, executionId, tenantId, owner: 'worker-1', policy, leaseMs: 5000, timeoutMs: 2000,
    clock: () => at(clockMs.now), step, approvalGate: gate,
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

describe('approval waits in real PostgreSQL', () => {
  it('waits for a human decision, then runs exactly one attempt and consumes the approval', async () => {
    const clock = { now: 0 };
    const gate = gateFor(tenantA, () => at(clock.now));
    const { executionId } = await store.createExecution(tenantA, `appr-${randomUUID()}`, 3);
    let steps = 0;
    const step = async () => { steps += 1; };
    const requested = await runDurableAttempt(drive(executionId, tenantA, clock, step, gate));
    expect(requested.status).toBe('approval_requested');
    if (requested.status !== 'approval_requested') return;
    // While waiting, nothing can be claimed and nothing runs.
    expect(await runDurableAttempt(drive(executionId, tenantA, clock, step, gate))).toEqual({ status: 'not_claimable' });
    expect(await resumeApprovalWait({ store, executionId, tenantId: tenantA, gate, clock: () => at(clock.now) })).toBe('waiting');
    expect(steps).toBe(0);
    // A reviewer other than the requester approves.
    expect(await approvals.approve(requested.approvalId, tenantA, 'reviewer-9', at(clock.now))).toBe(true);
    expect(await resumeApprovalWait({ store, executionId, tenantId: tenantA, gate, clock: () => at(clock.now) })).toBe('granted');
    expect(await runDurableAttempt(drive(executionId, tenantA, clock, step, gate))).toEqual({ status: 'succeeded', attempt: 1 });
    expect(steps).toBe(1);
    expect((await approvals.get(requested.approvalId, tenantA))?.status).toBe('consumed');
    const loaded = await store.load(executionId, tenantA);
    expect(loaded?.checkpoints.map((c) => c.state)).toEqual(['awaiting_approval', 'retry_wait', 'running', 'succeeded']);
  });

  it('cancels when a reviewer rejects, and never runs the side effect', async () => {
    const clock = { now: 0 };
    const gate = gateFor(tenantA, () => at(clock.now));
    const { executionId } = await store.createExecution(tenantA, `rej-${randomUUID()}`, 3);
    let steps = 0;
    const requested = await runDurableAttempt(drive(executionId, tenantA, clock, async () => { steps += 1; }, gate));
    if (requested.status !== 'approval_requested') throw new Error('expected an approval request');
    expect(await approvals.reject(requested.approvalId, tenantA, at(clock.now))).toBe(true);
    expect(await resumeApprovalWait({ store, executionId, tenantId: tenantA, gate, clock: () => at(clock.now) })).toBe('rejected');
    expect((await store.load(executionId, tenantA))?.execution.state).toBe('cancelled');
    expect(steps).toBe(0);
  });

  it('requires a new approval for every attempt, including retries', async () => {
    const clock = { now: 0 };
    const gate = gateFor(tenantA, () => at(clock.now));
    const { executionId } = await store.createExecution(tenantA, `each-${randomUUID()}`, 3);
    const first = await runDurableAttempt(drive(executionId, tenantA, clock, async () => undefined, gate));
    if (first.status !== 'approval_requested') throw new Error('expected an approval request');
    await approvals.approve(first.approvalId, tenantA, 'reviewer-9', at(clock.now));
    await resumeApprovalWait({ store, executionId, tenantId: tenantA, gate, clock: () => at(clock.now) });
    const failing = async () => { throw Object.assign(new Error('upstream reset'), { code: 'ECONNRESET' }); };
    expect((await runDurableAttempt(drive(executionId, tenantA, clock, failing, gate))).status).toBe('retry_scheduled');
    clock.now = 1000;
    const second = await runDurableAttempt(drive(executionId, tenantA, clock, failing, gate));
    expect(second.status).toBe('approval_requested');
    if (second.status === 'approval_requested') expect(second.approvalId).not.toBe(first.approvalId);
  });

  it('cancels instead of running when an approval was already consumed elsewhere', async () => {
    const clock = { now: 0 };
    const gate = gateFor(tenantA, () => at(clock.now));
    const { executionId } = await store.createExecution(tenantA, `race-appr-${randomUUID()}`, 3);
    const requested = await runDurableAttempt(drive(executionId, tenantA, clock, async () => undefined, gate));
    if (requested.status !== 'approval_requested') throw new Error('expected an approval request');
    await approvals.approve(requested.approvalId, tenantA, 'reviewer-9', at(clock.now));
    await resumeApprovalWait({ store, executionId, tenantId: tenantA, gate, clock: () => at(clock.now) });
    await approvals.consume(requested.approvalId, tenantA, at(clock.now)); // another consumer wins
    let steps = 0;
    expect(await runDurableAttempt(drive(executionId, tenantA, clock, async () => { steps += 1; }, gate)))
      .toEqual({ status: 'cancelled', reason: 'approval_already_consumed' });
    expect(steps).toBe(0);
  });
});

describe('cancellation in real PostgreSQL', () => {
  it('cancels a pending execution immediately', async () => {
    const { executionId } = await store.createExecution(tenantA, `cpend-${randomUUID()}`, 3);
    expect(await store.requestCancel(executionId, tenantA, at(0))).toBe('cancelled');
    expect(await runDurableAttempt(drive(executionId, tenantA, { now: 0 }, async () => undefined))).toEqual({ status: 'not_claimable' });
  });

  it('cancels while waiting for approval', async () => {
    const clock = { now: 0 };
    const gate = gateFor(tenantA, () => at(clock.now));
    const { executionId } = await store.createExecution(tenantA, `cwait-${randomUUID()}`, 3);
    expect((await runDurableAttempt(drive(executionId, tenantA, clock, async () => undefined, gate))).status).toBe('approval_requested');
    expect(await store.requestCancel(executionId, tenantA, at(0))).toBe('cancelled');
    expect((await store.load(executionId, tenantA))?.execution.state).toBe('cancelled');
  });

  it('honours a cancellation requested during an attempt that then fails', async () => {
    const { executionId } = await store.createExecution(tenantA, `cfail-${randomUUID()}`, 3);
    const outcome = await runDurableAttempt(drive(executionId, tenantA, { now: 0 }, async () => {
      expect(await store.requestCancel(executionId, tenantA, at(1000))).toBe('cancel_requested');
      throw Object.assign(new Error('upstream reset'), { code: 'ECONNRESET' });
    }));
    expect(outcome).toEqual({ status: 'cancelled', reason: 'requested' });
    expect((await store.load(executionId, tenantA))?.execution.state).toBe('cancelled');
  });

  it('keeps a successful side effect as succeeded even if cancellation arrived during it', async () => {
    const { executionId } = await store.createExecution(tenantA, `csucc-${randomUUID()}`, 3);
    const outcome = await runDurableAttempt(drive(executionId, tenantA, { now: 0 }, async () => {
      await store.requestCancel(executionId, tenantA, at(1000));
    }));
    expect(outcome).toEqual({ status: 'succeeded', attempt: 1 });
  });

  it('does not reveal executions to other tenants', async () => {
    const { executionId } = await store.createExecution(tenantA, `ctenant-${randomUUID()}`, 3);
    expect(await store.requestCancel(executionId, tenantB, at(0))).toBe('not_found');
  });
});

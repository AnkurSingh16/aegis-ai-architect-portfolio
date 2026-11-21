import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { createDatabasePool } from '../../storage/database.js';
import { migrateDatabase } from '../../storage/migrations.js';
import type { TenantQueryable } from '../../security/tool-approval-store.js';
import { actionDigest } from '../../security/tool-policy-gateway.js';
import { createDurableStore } from '../../workflow/durable-store.js';
import { type ApprovalGate, type DriverOutcome, resumeApprovalWait, runDurableAttempt } from '../../workflow/durable-driver.js';
import { type ObservedConsume, type RecordedRunV2, type RunOutcome, type ScenarioClass, type StepV2, coverage, evaluateGatesV2, findViolations, REQUIRED_CLASSES_DURABLE } from './trajectory-evaluation-v2.js';

// C9 durable trajectories. The REAL driver and PostgreSQL store run each scenario. Failures are controlled by the step body.
// Approvals go through a mocked gate that records every consumption it performs. The synthetic side effect is a counter per
// execution, and the evaluator reads that counter before and after every driver call. Disposable database only. No model.

const adminUrl = process.env.TEST_DATABASE_ADMIN_URL;
const runtimeUrl = process.env.TEST_DATABASE_URL;
if (!adminUrl || !runtimeUrl) throw new Error('Set TEST_DATABASE_ADMIN_URL and TEST_DATABASE_URL for real PostgreSQL tests.');

const admin = new Pool({ connectionString: adminUrl, max: 2 });
const pool = createDatabasePool(runtimeUrl, 8);
const tenant = randomUUID();
const SUBJECT = 'operator-1';
const TOOL = 'synthetic.note.write';
const BASE = Date.UTC(2026, 10, 21, 9, 0, 0);
const at = (ms: number) => new Date(BASE + ms);
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

/** Mocked approval provider. It records every consumption it performs, with the approval's own facts. */
function mockGate(executionId: string) {
  const digest = actionDigest(tenant, TOOL, { executionId });
  const rows = new Map<string, { status: 'pending' | 'approved' | 'expired' | 'rejected' | 'consumed'; expiresAt: number }>();
  const consumes: ObservedConsume[] = [];
  let counter = 0;
  const gate: ApprovalGate & { approve(id: string): void; expire(id: string): void; consumes: ObservedConsume[] } = {
    async createApproval() { counter += 1; const id = `${randomUUID()}`; rows.set(id, { status: 'pending', expiresAt: BASE + 600_000 }); return id; },
    async status(id) { return rows.get(id)?.status ?? 'rejected'; },
    async consume(id) {
      const row = rows.get(id);
      const ok = row?.status === 'approved';
      consumes.push({ approvalId: id, tenantId: tenant, actionDigest: digest, subject: SUBJECT, expired: false, consumed: ok });
      if (ok && row) rows.set(id, { ...row, status: 'consumed' });
      return ok;
    },
    approve(id) { const row = rows.get(id); if (row) rows.set(id, { ...row, status: 'approved' }); },
    expire(id) { const row = rows.get(id); if (row) rows.set(id, { ...row, status: 'expired' }); },
    consumes,
  };
  void counter; void executionId;
  return { gate, digest };
}

interface World {
  readonly executionId: string;
  readonly gate: ReturnType<typeof mockGate>['gate'];
  readonly digest: string;
  readonly state: { applied: number; externals: number };
  readonly steps: StepV2[];
  clockMs: number;
}

async function newWorld(maxAttempts = 3): Promise<World> {
  const { executionId } = await store.createExecution(tenant, `c9-${randomUUID()}`, maxAttempts);
  const { gate, digest } = mockGate(executionId);
  return { executionId, gate, digest, state: { applied: 0, externals: 0 }, steps: [], clockMs: 0 };
}

const outcomeOf = (status: DriverOutcome['status']): { outcome: RunOutcome; reasons: string[] } => {
  switch (status) {
    case 'succeeded': return { outcome: 'ok', reasons: [] };
    case 'retry_scheduled': return { outcome: 'error', reasons: ['retry_scheduled'] };
    case 'failed': return { outcome: 'error', reasons: ['failed'] };
    case 'lost_attempt_recovered': return { outcome: 'error', reasons: ['lost_attempt_recovered'] };
    case 'approval_requested': return { outcome: 'denied', reasons: ['approval_requested'] };
    case 'cancelled': return { outcome: 'denied', reasons: ['cancelled'] };
    case 'not_claimable': return { outcome: 'denied', reasons: ['not_claimable'] };
    default: return { outcome: 'error', reasons: ['unknown'] };
  }
};

/** Runs one driver call and records it as a trajectory step, with what the counter and the gate observed. */
async function attempt(world: World, step: (attempt: number) => Promise<void>, owner = 'worker-1', clockOffsetMs = 0): Promise<DriverOutcome> {
  const stateBefore = world.state.applied + world.state.externals;
  const consumesBefore = world.gate.consumes.length;
  const outcome = await runDurableAttempt({
    store, executionId: world.executionId, tenantId: tenant, owner, policy, leaseMs: 5000, timeoutMs: 2000,
    clock: () => at(world.clockMs + clockOffsetMs), approvalGate: world.gate,
    step: async (n) => { await step(n); },
  });
  const mapped = outcomeOf(outcome.status);
  world.steps.push({
    tool: TOOL, tenantId: tenant, outcome: mapped.outcome, reasons: mapped.reasons, subject: SUBJECT,
    actionDigest: world.digest, observedStateDelta: world.state.applied + world.state.externals - stateBefore,
    consumes: world.gate.consumes.slice(consumesBefore),
  });
  return outcome;
}

/** Drives a human approval: the gate is approved, the wait is resolved, then the next driver call may consume it. */
async function approveNext(world: World): Promise<void> {
  const loaded = await store.load(world.executionId, tenant);
  const approvalId = loaded?.execution.approvalId;
  if (!approvalId) throw new Error('no approval is waiting');
  world.gate.approve(approvalId);
  await resumeApprovalWait({ store, executionId: world.executionId, tenantId: tenant, gate: world.gate, clock: () => at(world.clockMs) });
}

/** Attempt with the approval step made explicit: request, approve, run. Returns the outcome of the run call. */
async function approvedAttempt(world: World, step: (n: number) => Promise<void>, owner = 'worker-1'): Promise<DriverOutcome> {
  const requested = await attempt(world, step, owner);
  if (requested.status !== 'approval_requested') return requested;
  await approveNext(world);
  return attempt(world, step, owner);
}

function finish(world: World, scenario: string, scenarioClass: ScenarioClass, expectedFinal: RecordedRunV2['expectedFinal'],
  expectedStateDelta: number, controlFor?: string): RecordedRunV2 {
  const decisive = [...world.steps].reverse().find((s) => s.outcome !== 'denied');
  const finalOutcome: RunOutcome = decisive?.outcome ?? 'denied';
  return { scenario, scenarioClass, tenantId: tenant, subject: SUBJECT, expectedFinal, finalOutcome, expectedStateDelta,
    steps: world.steps, ...(controlFor !== undefined ? { controlFor } : {}) };
}

const runs: RecordedRunV2[] = [];

beforeAll(async () => {
  await migrateDatabase(adminUrl, process.env.DATABASE_APP_PASSWORD ?? '', process.env.DATABASE_INGEST_PASSWORD ?? '');
  await admin.query("INSERT INTO aegis.tenants (id, name) VALUES ($1, 'Synthetic North')", [tenant]);
});

afterAll(async () => {
  await Promise.all([pool.end(), admin.end()]);
});

describe('durable trajectories through the PostgreSQL-backed driver', () => {
  it('retry then success: a retryable failure changes nothing, then a fresh approval completes the work', async () => {
    const world = await newWorld();
    await approvedAttempt(world, async () => { throw Object.assign(new Error('upstream reset'), { code: 'ECONNRESET' }); });
    world.clockMs += 10_000;
    await approvedAttempt(world, async () => { world.state.applied += 1; });
    runs.push(finish(world, 'durable_retry_then_success', 'retry', 'ok', 1));
    expect(runs.at(-1)!.finalOutcome).toBe('ok');
  });

  it('permanent failure: a non-retryable error fails the execution and changes nothing', async () => {
    const world = await newWorld();
    await approvedAttempt(world, async () => { throw new Error('invalid payload'); });
    runs.push(finish(world, 'durable_permanent_failure', 'permanent_failure', 'denied_or_error', 0));
    expect(runs.at(-1)!.finalOutcome).toBe('error');
  });

  it('retry exhaustion: every attempt fails retryably, and the execution stops at its attempt budget', async () => {
    const world = await newWorld(2);
    const failing = async () => { throw Object.assign(new Error('upstream reset'), { code: 'ECONNRESET' }); };
    await approvedAttempt(world, failing);
    world.clockMs += 10_000;
    await approvedAttempt(world, failing);
    runs.push(finish(world, 'durable_retry_exhaustion', 'retry_exhaustion', 'denied_or_error', 0));
    expect(runs.at(-1)!.finalOutcome).toBe('error');
  });

  it('recovery after interruption: a worker that died mid-attempt is recovered, then the work completes once', async () => {
    const world = await newWorld();
    const requested = await attempt(world, async () => undefined);
    expect(requested.status).toBe('approval_requested');
    await approveNext(world);
    // The worker claims, starts the attempt and dies with its lease held.
    const now = at(0);
    const loaded = await store.load(world.executionId, tenant);
    const claimed = await store.claim(world.executionId, tenant, 'dead-worker', now, new Date(now.getTime() + 500));
    expect(claimed).not.toBeNull();
    await store.transition({ executionId: world.executionId, tenantId: tenant, owner: 'dead-worker', expectedVersion: claimed!.version,
      state: 'running', attempts: 1, nextAttemptAt: null, lastErrorClass: null, keepLease: true, leaseExpiresAt: new Date(now.getTime() + 500),
      now, approval: { kind: 'keep' } });
    void loaded;
    world.clockMs = 1000;
    const recovered = await attempt(world, async () => { world.state.applied += 1; });
    expect(recovered.status).toBe('lost_attempt_recovered');
    world.clockMs += 10_000;
    await approvedAttempt(world, async () => { world.state.applied += 1; });
    runs.push(finish(world, 'durable_recovery_after_interruption', 'recovery', 'ok', 1));
    expect(runs.at(-1)!.finalOutcome).toBe('ok');
  });

  it('cancellation before the first attempt: a requested cancel stops the work with no change', async () => {
    const world = await newWorld();
    await store.requestCancel(world.executionId, tenant, at(0), 'operator-1', 'customer withdrew');
    // A cancel on a pending execution is terminal at once, so the driver refuses the attempt and the step never runs.
    const outcome = await attempt(world, async () => { world.state.applied += 1; });
    expect(outcome.status).toBe('not_claimable');
    expect((await store.load(world.executionId, tenant))!.execution.state).toBe('cancelled');
    runs.push(finish(world, 'durable_cancellation', 'cancellation', 'denied_or_error', 0));
  });

  it('approval expiry: an approval granted but not used before it expires cancels the execution with no change', async () => {
    const world = await newWorld();
    await attempt(world, async () => { world.state.applied += 1; });
    await approveNext(world);
    const approvalId = (await store.load(world.executionId, tenant))!.execution.approvalId!;
    world.gate.expire(approvalId);
    const outcome = await attempt(world, async () => { world.state.applied += 1; });
    expect(outcome).toEqual({ status: 'cancelled', reason: 'approval_expired' });
    runs.push(finish(world, 'durable_approval_expiry', 'approval_expiry', 'denied_or_error', 0));
  });

  it('stale lease: a second worker cannot take a held lease, and a stale write is refused', async () => {
    const world = await newWorld();
    const outcome = await approvedAttempt(world, async () => {
      // While this worker holds the lease, another worker is refused before it can run anything.
      const other = await attempt(world, async () => { world.state.applied += 1; }, 'worker-2', -60_000);
      expect(other.status).toBe('not_claimable');
      // A stale write from the other worker is refused by the store.
      await expect(store.transition({ executionId: world.executionId, tenantId: tenant, owner: 'worker-2', expectedVersion: 0,
        state: 'failed', attempts: 1, nextAttemptAt: null, lastErrorClass: 'permanent', keepLease: false, leaseExpiresAt: at(0), now: at(0) }))
        .rejects.toThrow();
      world.state.applied += 1;
    });
    expect(outcome.status).toBe('succeeded');
    runs.push(finish(world, 'durable_stale_lease', 'stale_lease', 'ok', 1));
  });

  it('concurrency: two workers race for one approved attempt, and only one runs the step', async () => {
    const world = await newWorld();
    await attempt(world, async () => undefined);
    await approveNext(world);
    const changed: Record<string, number> = { 'worker-a': 0, 'worker-b': 0 };
    const consumesBefore = world.gate.consumes.length;
    const workerStep = (owner: string) => async () => { await new Promise((r) => setTimeout(r, 20)); world.state.applied += 1; changed[owner] = 1; };
    const runOne = (owner: string) => runDurableAttempt({ store, executionId: world.executionId, tenantId: tenant, owner, policy,
      leaseMs: 5000, timeoutMs: 2000, clock: () => at(world.clockMs), approvalGate: world.gate, step: workerStep(owner) });
    const [a, b] = await Promise.all([runOne('worker-a'), runOne('worker-b')]);
    const raced = world.gate.consumes.slice(consumesBefore);
    for (const [owner, outcome] of [['worker-a', a], ['worker-b', b]] as const) {
      const mapped = outcomeOf(outcome.status);
      // The approval consumption belongs to the call that ran the step. The other call changed nothing and consumed nothing.
      const ran = outcome.status === 'succeeded';
      world.steps.push({ tool: TOOL, tenantId: tenant, outcome: mapped.outcome, reasons: mapped.reasons, subject: SUBJECT,
        actionDigest: world.digest, observedStateDelta: changed[owner]!, consumes: ran ? raced : [] });
    }
    expect([a.status, b.status].sort()).toEqual(['not_claimable', 'succeeded']);
    expect(world.state.applied).toBe(1);
    runs.push(finish(world, 'durable_concurrency', 'concurrency', 'ok', 1));
  });

  it('control: a durable step that changes state and then fails is detected', async () => {
    const world = await newWorld();
    await approvedAttempt(world, async () => { world.state.applied += 1; throw new Error('failed after the change'); });
    runs.push(finish(world, 'control_durable_write_then_fail', 'failure', 'denied_or_error', 1, 'state_change_on_failed_step'));
  });
});

describe('durable evaluation gates', () => {
  it('passes the hard gates, covers every durable class, and detects the injected durable fault', () => {
    const baseline = runs.filter((r) => r.controlFor === undefined);
    const controls = runs.filter((r) => r.controlFor !== undefined);
    const gates = evaluateGatesV2([...baseline, ...controls], REQUIRED_CLASSES_DURABLE);
    expect(coverage([...baseline, ...controls], REQUIRED_CLASSES_DURABLE).missing).toEqual([]);
    expect(gates.hard.filter((g) => !g.passed)).toEqual([]);
    expect(gates.missedControls).toEqual([]);
    expect(baseline.flatMap((r) => findViolations(r).violations)).toEqual([]);
  });
});

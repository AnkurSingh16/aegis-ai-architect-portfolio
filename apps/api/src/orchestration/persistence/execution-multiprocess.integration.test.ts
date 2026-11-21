import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { createDatabasePool } from '../../storage/database.js';
import { migrateDatabase } from '../../storage/migrations.js';
import { argsDigest, envelopeFor, principalRef, runWorker, sleep, spawnWorker, type WorkerExit } from './testing/support.js';

// P4 crash and concurrency acceptance. Every worker below is a separate operating-system process with its own PostgreSQL connection,
// running as the runtime role. Crashes are real SIGKILLs at a precise point (before or after a commit). State is checked directly in
// PostgreSQL through the owner connection, not through the store under test.
const adminUrl = process.env.TEST_DATABASE_ADMIN_URL;
const runtimeUrl = process.env.TEST_DATABASE_URL;
if (!adminUrl || !runtimeUrl) throw new Error('Set TEST_DATABASE_ADMIN_URL and TEST_DATABASE_URL for real PostgreSQL tests.');

const admin = new Pool({ connectionString: adminUrl, max: 2 });
const runtimeCheck = createDatabasePool(runtimeUrl, 1);
const tenant = randomUUID();
const ORCH = 'spiffe://aegis.local/workload/orchestrator';
const principal = principalRef('case-owner-multi');
const SCOPES = ['case:read', 'document:read'];
const LONG = 90_000;

const ok = (exit: WorkerExit) => exit.events.find((e) => e.event === 'RESULT') !== undefined
  && (exit.result as { ok: boolean }).ok === true;
const reason = (exit: WorkerExit): string | undefined => (exit.result as { reason?: string }).reason;
const bindingOf = (exit: WorkerExit) => exit.result as { value: Record<string, unknown> };

async function createExecution(options: { maxDelegations?: number; maxAttempts?: number; maxSteps?: number } = {}): Promise<string> {
  const id = await admin.query<{ execution_id: string }>(
    `INSERT INTO aegis.agent_executions (tenant_id, idempotency_key, principal_ref, principal_scopes, root_agent, max_depth, max_delegations,
       max_steps, grant_ttl_seconds, max_attempts)
     VALUES ($1, $2, $3, $4, 'orchestrator', 3, $5, $6, 300, $7) RETURNING execution_id`,
    [tenant, randomUUID(), principal, SCOPES, options.maxDelegations ?? 10, options.maxSteps ?? 10, options.maxAttempts ?? 5]);
  return id.rows[0].execution_id;
}

async function state(executionId: string) {
  const row = await admin.query<{ status: string; fencing_token: string; attempts: number; delegations_issued: number; steps_taken: number;
    lease_agent_id: string | null; lease_live: boolean }>(
    `SELECT status, fencing_token::text, attempts, delegations_issued, steps_taken, lease_agent_id,
            (lease_expires_at > clock_timestamp()) AS lease_live
       FROM aegis.agent_executions WHERE execution_id = $1`, [executionId]);
  return row.rows[0];
}

async function events(executionId: string): Promise<Array<{ event_type: string; outcome: string; reason: string | null; fencing_token: string | null }>> {
  const rows = await admin.query<{ event_type: string; outcome: string; reason: string | null; fencing_token: string | null }>(
    'SELECT event_type, outcome, reason, fencing_token::text FROM aegis.agent_execution_events WHERE execution_id = $1 ORDER BY event_id',
    [executionId]);
  return rows.rows;
}

/** Claims through a worker process and returns the fence it carries. */
async function claimThroughWorker(executionId: string, instance: string, leaseSeconds = 30) {
  const exit = await runWorker({ op: 'claim', tenantId: tenant, executionId, spiffeId: ORCH, instance, leaseSeconds });
  if (!ok(exit)) throw new Error(`claim refused: ${reason(exit)}`);
  const value = bindingOf(exit).value as { fencingToken: number; agentId: string };
  return { tenantId: tenant, executionId, agentId: value.agentId, instance, fencingToken: value.fencingToken };
}

async function waitForLeaseRelease(executionId: string, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await state(executionId)).lease_live) return;
    await sleep(250);
  }
  throw new Error('lease did not expire in time');
}

beforeAll(async () => {
  await migrateDatabase(adminUrl, process.env.DATABASE_APP_PASSWORD ?? '', process.env.DATABASE_INGEST_PASSWORD ?? '');
  await admin.query("INSERT INTO aegis.tenants (id, name) VALUES ($1, 'Synthetic North')", [tenant]);
});

afterAll(async () => {
  await runtimeCheck.end();
  await admin.end();
});

describe('concurrent workers in separate processes', () => {
  it('1. five workers claim the same execution at the same instant: exactly one holds the lease', async () => {
    const executionId = await createExecution();
    const startAt = Date.now() + 7000;
    const workers = Array.from({ length: 5 }, (_, i) => runWorker({
      op: 'claim', tenantId: tenant, executionId, spiffeId: ORCH, instance: `orchestrator-${i}`, leaseSeconds: 60, startAt,
    }));
    const results = await Promise.all(workers);
    expect(results.filter(ok)).toHaveLength(1);
    expect(results.filter((r) => !ok(r)).map(reason)).toEqual(['lease_held', 'lease_held', 'lease_held', 'lease_held']);
    const s = await state(executionId);
    expect(s.fencing_token).toBe('1');
    expect(s.attempts).toBe(1);
    expect((await events(executionId)).filter((e) => e.event_type === 'claimed')).toHaveLength(1);
  }, LONG);

  it('2. ten workers consume one grant at the same instant: exactly one succeeds, and the grant is consumed once', async () => {
    const executionId = await createExecution();
    const fence = await claimThroughWorker(executionId, 'orchestrator-1');
    const delegated = await runWorker({ op: 'delegate', fence, parentSeq: null, to: 'triage', requestedScopes: ['case:read'] });
    expect(ok(delegated)).toBe(true);
    const args = { caseRef: 'synthetic-concurrent' };
    const chain = [{ from: 'orchestrator', to: 'triage', effectiveScopes: ['case:read'] }];
    const granted = await runWorker({ op: 'grant', fence, chainSeq: 1, kind: 'request', action: 'triage.classify',
      argumentsDigest: argsDigest(args), requiredScopes: ['case:read'] });
    expect(ok(granted)).toBe(true);
    const envelope = envelopeFor({ executionId, tenantId: tenant, principal, from: 'orchestrator', to: 'triage', chain,
      action: 'triage.classify', args });
    const startAt = Date.now() + 8000;
    const results = await Promise.all(Array.from({ length: 10 }, () => runWorker({ op: 'consume', fence, envelope, startAt })));
    expect(results.filter(ok)).toHaveLength(1);
    expect(results.filter((r) => !ok(r)).every((r) => reason(r) === 'grant_consumed')).toBe(true);
    const grants = await admin.query<{ status: string; n: string }>(
      `SELECT status, count(*)::text AS n FROM aegis.agent_grants WHERE execution_id = $1 GROUP BY status`, [executionId]);
    expect(grants.rows).toEqual([{ status: 'consumed', n: '1' }]);
    expect((await state(executionId)).steps_taken).toBe(1);
    expect((await events(executionId)).filter((e) => e.event_type === 'grant_consumed')).toHaveLength(1);
  }, LONG);

  it('3. two branches in separate processes race for the final global delegation: exactly one is recorded', async () => {
    const executionId = await createExecution({ maxDelegations: 2 });
    const fence = await claimThroughWorker(executionId, 'orchestrator-1');
    expect(ok(await runWorker({ op: 'delegate', fence, parentSeq: null, to: 'triage', requestedScopes: ['case:read'] }))).toBe(true);
    const startAt = Date.now() + 8000;
    const [branchA, branchB] = await Promise.all([
      runWorker({ op: 'delegate', fence, parentSeq: 1, to: 'reviewer', requestedScopes: ['case:read'], startAt }),
      runWorker({ op: 'delegate', fence, parentSeq: null, to: 'retrieval', requestedScopes: ['document:read'], startAt }),
    ]);
    expect([branchA, branchB].filter(ok)).toHaveLength(1);
    expect([branchA, branchB].filter((r) => !ok(r)).map(reason)).toEqual(['delegation_budget_exceeded']);
    const s = await state(executionId);
    expect(s.delegations_issued).toBe(2);
    const hops = await admin.query<{ n: string }>('SELECT count(*)::text AS n FROM aegis.agent_delegations WHERE execution_id = $1', [executionId]);
    expect(hops.rows[0].n).toBe('2');
  }, LONG);

  it('4. two workers issue the same grant at once: one open grant results, the other is refused as a duplicate', async () => {
    const executionId = await createExecution();
    const fence = await claimThroughWorker(executionId, 'orchestrator-1');
    expect(ok(await runWorker({ op: 'delegate', fence, parentSeq: null, to: 'triage', requestedScopes: ['case:read'] }))).toBe(true);
    const startAt = Date.now() + 8000;
    const grantArgs = { op: 'grant', fence, chainSeq: 1, kind: 'request', action: 'triage.classify', argumentsDigest: argsDigest({ caseRef: 'dup' }),
      requiredScopes: ['case:read'], startAt };
    const results = await Promise.all([runWorker(grantArgs), runWorker(grantArgs)]);
    expect(results.filter(ok)).toHaveLength(1);
    expect(results.filter((r) => !ok(r)).map(reason)).toEqual(['duplicate_open_grant']);
  }, LONG);
});

describe('crashes, lease expiry, fencing and recovery', () => {
  it('5. a worker killed before its commit leaves no trace; a worker killed after its commit leaves the transition in place', async () => {
    const executionId = await createExecution();
    const fence = await claimThroughWorker(executionId, 'orchestrator-1', 60);

    // Killed after COMMIT returned: the delegation must be durable.
    const committed = spawnWorker({ op: 'delegate', fence, parentSeq: null, to: 'triage', requestedScopes: ['case:read'],
      pauseAfterCommit: 'delegate:accepted' });
    await committed.waitForEvent('COMMITTED');
    committed.kill();
    await committed.exited();
    expect((await state(executionId)).delegations_issued).toBe(1);
    expect((await events(executionId)).filter((e) => e.event_type === 'delegation_recorded')).toHaveLength(1);

    // Killed before COMMIT: nothing it did may persist, not the counter, not the hop, not the audit row.
    const uncommitted = spawnWorker({ op: 'delegate', fence, parentSeq: null, to: 'reviewer', requestedScopes: ['case:read'],
      pauseBeforeCommit: 'delegate:accepted' });
    await uncommitted.waitForEvent('PAUSED');
    uncommitted.kill();
    await uncommitted.exited();
    expect((await state(executionId)).delegations_issued).toBe(1);
    const hops = await admin.query<{ to_agent: string }>('SELECT to_agent FROM aegis.agent_delegations WHERE execution_id = $1 ORDER BY seq', [executionId]);
    expect(hops.rows.map((r) => r.to_agent)).toEqual(['triage']);
    expect((await events(executionId)).filter((e) => e.event_type === 'delegation_recorded')).toHaveLength(1);
  }, LONG);

  it('6. a claim killed before commit is not recorded; the lease is only taken by a committed claim', async () => {
    const executionId = await createExecution();
    const doomed = spawnWorker({ op: 'claim', tenantId: tenant, executionId, spiffeId: ORCH, instance: 'orchestrator-x', leaseSeconds: 30,
      pauseBeforeCommit: 'claim:accepted' });
    await doomed.waitForEvent('PAUSED');
    doomed.kill();
    await doomed.exited();
    const s = await state(executionId);
    expect(s.lease_agent_id).toBeNull();
    expect(s.fencing_token).toBe('0');
    expect(s.attempts).toBe(0);
  }, LONG);

  it('7. worker termination: lease expiry, recovery by another worker, persisted state carried over, and a stale late commit refused', async () => {
    const executionId = await createExecution();
    const first = await claimThroughWorker(executionId, 'orchestrator-1', 8);
    expect(first.fencingToken).toBe(1);
    // The first worker is killed in the middle of a delegation (before its commit). Its lease is still live, so it blocks others.
    const crashed = spawnWorker({ op: 'delegate', fence: first, parentSeq: null, to: 'triage', requestedScopes: ['case:read'],
      pauseBeforeCommit: 'delegate:accepted' });
    await crashed.waitForEvent('PAUSED');
    crashed.kill();
    await crashed.exited();
    const blocked = await runWorker({ op: 'claim', tenantId: tenant, executionId, spiffeId: ORCH, instance: 'orchestrator-2', leaseSeconds: 30 });
    expect(reason(blocked)).toBe('lease_held');

    await waitForLeaseRelease(executionId);
    const recovered = await runWorker({ op: 'claim', tenantId: tenant, executionId, spiffeId: ORCH, instance: 'orchestrator-2', leaseSeconds: 60 });
    expect(ok(recovered)).toBe(true);
    const second = (bindingOf(recovered).value as { fencingToken: number; attempts: number; recovered: boolean });
    expect(second.fencingToken).toBe(2);
    expect(second.attempts).toBe(2);
    expect(second.recovered).toBe(true);

    // The recovered worker continues from the persisted state. The killed worker's delegation never happened, so the budget is untouched.
    const continued = { op: 'delegate', parentSeq: null, to: 'triage', requestedScopes: ['case:read'] };
    const after = await runWorker({ ...continued, fence: { ...first, instance: 'orchestrator-2', fencingToken: 2 } });
    expect(ok(after)).toBe(true);

    // The first worker wakes up late and tries to commit with its old token. It must be refused, and nothing changes.
    const late = await runWorker({ ...continued, to: 'reviewer', fence: first });
    expect(reason(late)).toBe('stale_fence');
    const s = await state(executionId);
    expect(s.delegations_issued).toBe(1);
    const audit = await events(executionId);
    expect(audit.some((e) => e.event_type === 'fenced_write_refused' && e.reason === 'stale_fence' && e.fencing_token === '1')).toBe(true);
    expect(audit.some((e) => e.event_type === 'claimed' && e.reason === 'recovered')).toBe(true);
  }, LONG);

  it('8. retry exhaustion across processes: a third claim after two abandoned attempts fails the execution', async () => {
    const executionId = await createExecution({ maxAttempts: 2 });
    await claimThroughWorker(executionId, 'orchestrator-1', 1);
    await waitForLeaseRelease(executionId);
    await claimThroughWorker(executionId, 'orchestrator-2', 1);
    await waitForLeaseRelease(executionId);
    const exhausted = await runWorker({ op: 'claim', tenantId: tenant, executionId, spiffeId: ORCH, instance: 'orchestrator-3', leaseSeconds: 30 });
    expect(reason(exhausted)).toBe('retries_exhausted');
    const s = await state(executionId);
    expect(s.status).toBe('failed');
    expect(s.lease_agent_id).toBeNull();
  }, LONG);

  it('9. a cancellation from another process is honoured by the lease holder at its next write, then applied by release', async () => {
    const executionId = await createExecution();
    const fence = await claimThroughWorker(executionId, 'orchestrator-1', 60);
    const requested = await runWorker({ op: 'cancel', tenantId: tenant, executionId, reason: 'operator stopped the run' });
    expect(bindingOf(requested).value).toEqual({ state: 'cancel_requested' });
    const refused = await runWorker({ op: 'delegate', fence, parentSeq: null, to: 'triage', requestedScopes: ['case:read'] });
    expect(reason(refused)).toBe('cancel_requested');
    const released = await runWorker({ op: 'release', fence, nextStatus: 'cancelled', reason: 'cancel_requested' });
    expect(ok(released)).toBe(true);
    expect((await state(executionId)).status).toBe('cancelled');
    expect((await state(executionId)).delegations_issued).toBe(0);
  }, LONG);
});

describe('persisted state is what a restarted process sees', () => {
  it('10. after a crash, a new process reads the same chain, budget and grant state from PostgreSQL', async () => {
    const executionId = await createExecution({ maxDelegations: 3 });
    const fence = await claimThroughWorker(executionId, 'orchestrator-1', 10);
    expect(ok(await runWorker({ op: 'delegate', fence, parentSeq: null, to: 'triage', requestedScopes: ['case:read'] }))).toBe(true);
    const args = { caseRef: 'restart' };
    expect(ok(await runWorker({ op: 'grant', fence, chainSeq: 1, kind: 'request', action: 'triage.classify',
      argumentsDigest: argsDigest(args), requiredScopes: ['case:read'] }))).toBe(true);
    const crash = spawnWorker({ op: 'delegate', fence, parentSeq: 1, to: 'reviewer', requestedScopes: ['case:read'],
      pauseAfterCommit: 'delegate:accepted' });
    await crash.waitForEvent('COMMITTED');
    crash.kill();
    await crash.exited();
    await waitForLeaseRelease(executionId);

    const restarted = await claimThroughWorker(executionId, 'orchestrator-restarted', 30);
    expect(restarted.fencingToken).toBe(2);
    const s = await state(executionId);
    expect(s.delegations_issued).toBe(2);
    const chain = await admin.query<{ seq: number; parent_seq: number | null; to_agent: string }>(
      'SELECT seq, parent_seq, to_agent FROM aegis.agent_delegations WHERE execution_id = $1 ORDER BY seq', [executionId]);
    expect(chain.rows).toEqual([
      { seq: 1, parent_seq: null, to_agent: 'triage' },
      { seq: 2, parent_seq: 1, to_agent: 'reviewer' },
    ]);
    const grant = await admin.query<{ status: string }>('SELECT status FROM aegis.agent_grants WHERE execution_id = $1', [executionId]);
    expect(grant.rows).toEqual([{ status: 'open' }]);
    // The restarted worker can use the persisted open grant exactly once.
    const envelope = envelopeFor({ executionId, tenantId: tenant, principal, from: 'orchestrator', to: 'triage',
      chain: [{ from: 'orchestrator', to: 'triage', effectiveScopes: ['case:read'] }], action: 'triage.classify', args });
    expect(ok(await runWorker({ op: 'consume', fence: { ...fence, instance: 'orchestrator-restarted', fencingToken: 2 }, envelope }))).toBe(true);
    expect(ok(await runWorker({ op: 'consume', fence: { ...fence, instance: 'orchestrator-restarted', fencingToken: 2 }, envelope })))
      .toBe(false);
  }, LONG);
});

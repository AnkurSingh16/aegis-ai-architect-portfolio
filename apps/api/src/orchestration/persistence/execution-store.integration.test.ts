import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { createDatabasePool } from '../../storage/database.js';
import { migrateDatabase } from '../../storage/migrations.js';
import type { TenantQueryable } from '../../security/tool-approval-store.js';
import { createAgentExecutionStore, type Fence } from './execution-store.js';
import { chainDigest } from '../delegation.js';
import { argsDigest, envelopeFor, principalRef, sleep } from './testing/support.js';
import type { DelegationChain } from '../types.js';

// P4 in real PostgreSQL, in one process. Concurrency across processes is in execution-multiprocess.integration.test.ts.
const adminUrl = process.env.TEST_DATABASE_ADMIN_URL;
const runtimeUrl = process.env.TEST_DATABASE_URL;
if (!adminUrl || !runtimeUrl) throw new Error('Set TEST_DATABASE_ADMIN_URL and TEST_DATABASE_URL for real PostgreSQL tests.');

const admin = new Pool({ connectionString: adminUrl, max: 2 });
const pool = createDatabasePool(runtimeUrl, 8);
const tenantA = randomUUID();
const tenantB = randomUUID();

const SPIFFE = {
  orchestrator: 'spiffe://aegis.local/workload/orchestrator',
  triage: 'spiffe://aegis.local/workload/triage',
  retrieval: 'spiffe://aegis.local/workload/retrieval',
  reviewer: 'spiffe://aegis.local/workload/reviewer',
  unregistered: 'spiffe://aegis.local/workload/probe',
};
const principal = principalRef('case-owner-1');
const PRINCIPAL_SCOPES = ['case:read', 'document:read'];
const DEFAULTS = { maxDepth: 3, maxDelegations: 5, maxSteps: 10 };

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

const store = createAgentExecutionStore(runTenant);

async function newExecution(options: { tenantId?: string; maxDepth?: number; maxDelegations?: number; maxSteps?: number;
  grantTtlSeconds?: number; maxAttempts?: number; key?: string } = {}): Promise<string> {
  const tenantId = options.tenantId ?? tenantA;
  const created = await store.createExecution({ tenantId, idempotencyKey: options.key ?? randomUUID(), principalRef: principal,
    principalScopes: PRINCIPAL_SCOPES,
    limits: { maxDepth: options.maxDepth ?? DEFAULTS.maxDepth, maxDelegations: options.maxDelegations ?? DEFAULTS.maxDelegations,
      maxSteps: options.maxSteps ?? DEFAULTS.maxSteps },
    grantTtlSeconds: options.grantTtlSeconds ?? 300, maxAttempts: options.maxAttempts ?? 5 });
  return created.executionId;
}

/** Claims as the orchestrator and returns the fence a real worker would carry. */
async function claimAsOrchestrator(executionId: string, instance = 'orchestrator-1', leaseSeconds = 60, tenantId = tenantA): Promise<Fence> {
  const claim = await store.claim({ tenantId, executionId, spiffeId: SPIFFE.orchestrator, instance, leaseSeconds });
  if (!claim.ok) throw new Error(`claim refused: ${claim.reason}`);
  return { tenantId, executionId, agentId: claim.value.agentId, instance, fencingToken: claim.value.fencingToken };
}

const rootToTriage = (): DelegationChain => [{ from: 'orchestrator', to: 'triage', effectiveScopes: ['case:read'] }];

async function delegateToTriage(fence: Fence, scopes = ['case:read']) {
  const r = await store.recordDelegation(fence, { parentSeq: null, to: 'triage', requestedScopes: scopes });
  if (!r.ok) throw new Error(`delegation refused: ${r.reason}`);
  return r.value;
}

beforeAll(async () => {
  await migrateDatabase(adminUrl, process.env.DATABASE_APP_PASSWORD ?? '', process.env.DATABASE_INGEST_PASSWORD ?? '');
  await admin.query("INSERT INTO aegis.tenants (id, name) VALUES ($1, 'Synthetic North'), ($2, 'Synthetic South')", [tenantA, tenantB]);
});

afterAll(async () => {
  await pool.end();
  await admin.end();
});

describe('registrations and claims', () => {
  it('a SPIFFE identity that is not registered cannot claim an execution', async () => {
    const executionId = await newExecution();
    const claim = await store.claim({ tenantId: tenantA, executionId, spiffeId: SPIFFE.unregistered, instance: 'probe', leaseSeconds: 30 });
    expect(claim).toEqual({ ok: false, reason: 'not_registered' });
  });

  it('a registered agent that is not the orchestrator cannot drive an execution', async () => {
    const executionId = await newExecution();
    const claim = await store.claim({ tenantId: tenantA, executionId, spiffeId: SPIFFE.triage, instance: 'triage-1', leaseSeconds: 30 });
    expect(claim).toEqual({ ok: false, reason: 'not_orchestrator' });
  });

  it('the orchestrator claims once; a second claim while the lease is live is refused', async () => {
    const executionId = await newExecution();
    const fence = await claimAsOrchestrator(executionId);
    expect(fence.fencingToken).toBe(1);
    const second = await store.claim({ tenantId: tenantA, executionId, spiffeId: SPIFFE.orchestrator, instance: 'orchestrator-2', leaseSeconds: 30 });
    expect(second).toEqual({ ok: false, reason: 'lease_held' });
    const snapshot = await store.snapshot(tenantA, executionId);
    expect(snapshot?.leaseAgentId).toBe('orchestrator');
    expect(snapshot?.status).toBe('running');
  });

  it('the same idempotency key returns the same execution and does not create a second one', async () => {
    const key = `idem-${randomUUID()}`;
    const first = await newExecution({ key });
    const again = await store.createExecution({ tenantId: tenantA, idempotencyKey: key, principalRef: principal,
      principalScopes: PRINCIPAL_SCOPES, limits: DEFAULTS, grantTtlSeconds: 300, maxAttempts: 5 });
    expect(again).toEqual({ executionId: first, created: false });
  });
});

describe('delegation: continuity, budgets and scopes', () => {
  it('records a root hop and refuses scope escalation to a delegate that does not hold the scope', async () => {
    const executionId = await newExecution();
    const fence = await claimAsOrchestrator(executionId);
    const ok = await store.recordDelegation(fence, { parentSeq: null, to: 'triage', requestedScopes: ['case:read'] });
    expect(ok).toEqual({ ok: true, value: { seq: 1, depth: 1 } });
    const escalation = await store.recordDelegation(fence, { parentSeq: null, to: 'retrieval', requestedScopes: ['case:read'] });
    expect(escalation).toEqual({ ok: false, reason: 'scope_escalation' });
    const write = await store.recordDelegation(fence, { parentSeq: null, to: 'reviewer', requestedScopes: ['case:write'] });
    expect(write).toEqual({ ok: false, reason: 'scope_escalation' });
  });

  it('refuses a delegation that would revisit an agent already on the chain', async () => {
    const executionId = await newExecution();
    const fence = await claimAsOrchestrator(executionId);
    await delegateToTriage(fence);
    const cycle = await store.recordDelegation(fence, { parentSeq: 1, to: 'orchestrator', requestedScopes: ['case:read'] });
    expect(cycle).toEqual({ ok: false, reason: 'cycle' });
  });

  it('refuses a hop beyond the execution depth limit', async () => {
    const executionId = await newExecution({ maxDepth: 1 });
    const fence = await claimAsOrchestrator(executionId);
    const seq = await delegateToTriage(fence);
    const deeper = await store.recordDelegation(fence, { parentSeq: seq.seq, to: 'retrieval', requestedScopes: ['document:read'] });
    expect(deeper).toEqual({ ok: false, reason: 'depth_exceeded' });
  });

  it('refuses delegation once the execution-wide budget is spent, whichever branch spends it', async () => {
    const executionId = await newExecution({ maxDelegations: 2 });
    const fence = await claimAsOrchestrator(executionId);
    const first = await delegateToTriage(fence);
    const sibling = await store.recordDelegation(fence, { parentSeq: null, to: 'reviewer', requestedScopes: ['case:read'] });
    expect(sibling).toEqual({ ok: true, value: { seq: 2, depth: 1 } });
    const third = await store.recordDelegation(fence, { parentSeq: first.seq, to: 'retrieval', requestedScopes: ['document:read'] });
    expect(third).toEqual({ ok: false, reason: 'delegation_budget_exceeded' });
    const snapshot = await store.snapshot(tenantA, executionId);
    expect(snapshot?.delegationsIssued).toBe(2);
  });

  it('the database refuses a hop whose sender is not the holder of its parent, even when the application is bypassed', async () => {
    const executionId = await newExecution();
    const fence = await claimAsOrchestrator(executionId);
    const first = await delegateToTriage(fence);
    await expect(runTenant(tenantA, (client) => client.query(
      `INSERT INTO aegis.agent_delegations (tenant_id, execution_id, seq, parent_seq, depth, from_agent, to_agent, effective_scopes,
         chain_digest, fencing_token) VALUES ($1, $2, 2, $3, 2, 'retrieval', 'reviewer', ARRAY['document:read'], $4, 1)`,
      [tenantA, executionId, first.seq, 'a'.repeat(64)]))).rejects.toThrow(/discontinuous/);
  });

  it('the database refuses a counter beyond the budget even when the application is bypassed', async () => {
    const executionId = await newExecution({ maxDelegations: 1 });
    await claimAsOrchestrator(executionId);
    await expect(runTenant(tenantA, (client) => client.query(
      'UPDATE aegis.agent_executions SET delegations_issued = 2 WHERE execution_id = $1', [executionId]))).rejects.toThrow(/check constraint/);
  });

  it('records the chain digest of the hop, and refuses the same hop recorded twice', async () => {
    const executionId = await newExecution();
    const fence = await claimAsOrchestrator(executionId);
    await delegateToTriage(fence);
    const rows = await store.delegations(tenantA, executionId);
    expect(rows[0].chainDigest).toBe(chainDigest(rootToTriage()));
    expect(await store.recordDelegation(fence, { parentSeq: null, to: 'triage', requestedScopes: ['case:read'] }))
      .toEqual({ ok: false, reason: 'duplicate_delegation' });
  });
});

describe('grants: single use, binding and authority', () => {
  async function issueTriageRequest(fence: Fence, executionId: string, action = 'triage.classify', args = { caseRef: 'synthetic-1' }) {
    await delegateToTriage(fence);
    const issued = await store.issueGrant(fence, { chainSeq: 1, kind: 'request', action, argumentsDigest: argsDigest(args),
      requiredScopes: ['case:read'] });
    if (!issued.ok) throw new Error(`grant refused: ${issued.reason}`);
    return envelopeFor({ executionId, tenantId: tenantA, principal, from: 'orchestrator', to: 'triage', chain: rootToTriage(),
      action, args });
  }

  it('one grant authorises exactly one envelope; the replay is refused as consumed', async () => {
    const executionId = await newExecution();
    const fence = await claimAsOrchestrator(executionId);
    const envelope = await issueTriageRequest(fence, executionId);
    const first = await store.consumeEnvelope(fence, envelope);
    expect(first.ok).toBe(true);
    if (first.ok) expect(first.value.stepsTaken).toBe(1);
    const replay = await store.consumeEnvelope(fence, envelope);
    expect(replay).toEqual({ ok: false, reason: 'grant_consumed' });
    const grants = await store.grants(tenantA, executionId);
    expect(grants.map((g) => [g.status, g.consumedBy])).toEqual([['consumed', 'orchestrator']]);
  });

  it('refuses a message with an unknown field, a forged principal, or changed arguments', async () => {
    const executionId = await newExecution();
    const fence = await claimAsOrchestrator(executionId);
    const envelope = await issueTriageRequest(fence, executionId);
    expect(await store.consumeEnvelope(fence, { ...envelope, authority: 'admin' })).toEqual({ ok: false, reason: 'unexpected_fields' });
    expect(await store.consumeEnvelope(fence, { ...envelope, principalRef: principalRef('someone-else') }))
      .toEqual({ ok: false, reason: 'authority_mismatch' });
    expect(await store.consumeEnvelope(fence, { ...envelope, argumentsDigest: argsDigest({ caseRef: 'other' }) }))
      .toEqual({ ok: false, reason: 'not_granted' });
    // The grant is still open: none of the refused attempts consumed it.
    expect((await store.consumeEnvelope(fence, envelope)).ok).toBe(true);
  });

  it('a request grant does not authorise a result envelope (kind is part of the binding)', async () => {
    const executionId = await newExecution();
    const fence = await claimAsOrchestrator(executionId);
    const envelope = await issueTriageRequest(fence, executionId);
    expect(await store.consumeEnvelope(fence, { ...envelope, kind: 'result' })).toEqual({ ok: false, reason: 'not_granted' });
  });

  it('refuses a duplicate open grant for the same envelope', async () => {
    const executionId = await newExecution();
    const fence = await claimAsOrchestrator(executionId);
    await delegateToTriage(fence);
    const args = { caseRef: 'synthetic-1' };
    const input = { chainSeq: 1, kind: 'request' as const, action: 'triage.classify', argumentsDigest: argsDigest(args), requiredScopes: ['case:read'] };
    expect((await store.issueGrant(fence, input)).ok).toBe(true);
    expect(await store.issueGrant(fence, input)).toEqual({ ok: false, reason: 'duplicate_open_grant' });
  });

  it('refuses a grant whose destination does not hold the required scope', async () => {
    const executionId = await newExecution();
    const fence = await claimAsOrchestrator(executionId);
    await delegateToTriage(fence);
    const refused = await store.issueGrant(fence, { chainSeq: 1, kind: 'request', action: 'case.write', argumentsDigest: argsDigest({}),
      requiredScopes: ['case:write'] });
    expect(refused).toEqual({ ok: false, reason: 'scope_escalation' });
  });

  it('an expired grant cannot authorise anything, and it is revoked by the next decision', async () => {
    const executionId = await newExecution({ grantTtlSeconds: 1 });
    const fence = await claimAsOrchestrator(executionId);
    const envelope = await issueTriageRequest(fence, executionId);
    await sleep(1500);
    expect(await store.consumeEnvelope(fence, envelope)).toEqual({ ok: false, reason: 'not_granted' });
    const grants = await store.grants(tenantA, executionId);
    expect(grants[0].status).toBe('revoked');
  });

  it('the step budget is global: a second consumption beyond the limit is refused', async () => {
    const executionId = await newExecution({ maxSteps: 1 });
    const fence = await claimAsOrchestrator(executionId);
    const envelope = await issueTriageRequest(fence, executionId);
    expect((await store.consumeEnvelope(fence, envelope)).ok).toBe(true);
    const args2 = { caseRef: 'synthetic-2' };
    const second = envelopeFor({ executionId, tenantId: tenantA, principal, from: 'orchestrator', to: 'triage', chain: rootToTriage(),
      action: 'triage.classify', args: args2 });
    await store.issueGrant(fence, { chainSeq: 1, kind: 'request', action: 'triage.classify', argumentsDigest: argsDigest(args2),
      requiredScopes: ['case:read'] });
    expect(await store.consumeEnvelope(fence, second)).toEqual({ ok: false, reason: 'step_budget_exceeded' });
  });

  it('the database forbids rebinding a grant and reopening a final grant', async () => {
    const executionId = await newExecution();
    const fence = await claimAsOrchestrator(executionId);
    const envelope = await issueTriageRequest(fence, executionId);
    const grantId = (await store.grants(tenantA, executionId))[0].grantId;
    // The runtime role has no privilege on the binding columns at all. The trigger is tested as the owner, which is the stronger case.
    await expect(runTenant(tenantA, (client) => client.query(
      "UPDATE aegis.agent_grants SET action = 'triage.delete' WHERE grant_id = $1", [grantId]))).rejects.toThrow(/permission denied/);
    await expect(admin.query("UPDATE aegis.agent_grants SET action = 'triage.delete' WHERE grant_id = $1", [grantId])).rejects.toThrow(/immutable/);
    expect((await store.consumeEnvelope(fence, envelope)).ok).toBe(true);
    await expect(runTenant(tenantA, (client) => client.query(
      "UPDATE aegis.agent_grants SET status = 'open', consumed_at = NULL, consumed_by_agent = NULL, consumed_by_fencing_token = NULL WHERE grant_id = $1", [grantId])))
      .rejects.toThrow(/final/);
  });
});

describe('leases, fencing, cancellation and retries', () => {
  it('a stale worker whose lease expired is refused, and its refusal is audited', async () => {
    const executionId = await newExecution();
    const stale = await claimAsOrchestrator(executionId, 'orchestrator-1', 1);
    await sleep(1500);
    const fresh = await claimAsOrchestrator(executionId, 'orchestrator-2', 60);
    expect(fresh.fencingToken).toBe(2);
    expect(await store.recordDelegation(stale, { parentSeq: null, to: 'triage', requestedScopes: ['case:read'] }))
      .toEqual({ ok: false, reason: 'stale_fence' });
    const events = await store.events(tenantA, executionId);
    expect(events.some((e) => e.eventType === 'fenced_write_refused' && e.reason === 'stale_fence' && e.fencingToken === 1)).toBe(true);
    const snapshot = await store.snapshot(tenantA, executionId);
    expect(snapshot?.delegationsIssued).toBe(0);
    // The current holder is unaffected.
    expect((await store.recordDelegation(fresh, { parentSeq: null, to: 'triage', requestedScopes: ['case:read'] })).ok).toBe(true);
  });

  it('a recovered execution is marked as recovered, and the previous attempt count is kept', async () => {
    const executionId = await newExecution({ maxAttempts: 3 });
    await claimAsOrchestrator(executionId, 'orchestrator-1', 1);
    await sleep(1500);
    const claim = await store.claim({ tenantId: tenantA, executionId, spiffeId: SPIFFE.orchestrator, instance: 'orchestrator-2', leaseSeconds: 30 });
    expect(claim.ok && claim.value.recovered && claim.value.attempts === 2).toBe(true);
  });

  it('retry exhaustion fails the execution and revokes its open grants', async () => {
    const executionId = await newExecution({ maxAttempts: 2 });
    await claimAsOrchestrator(executionId, 'orchestrator-1', 1);
    await sleep(1500);
    await claimAsOrchestrator(executionId, 'orchestrator-2', 1);
    await sleep(1500);
    const exhausted = await store.claim({ tenantId: tenantA, executionId, spiffeId: SPIFFE.orchestrator, instance: 'orchestrator-3', leaseSeconds: 30 });
    expect(exhausted).toEqual({ ok: false, reason: 'retries_exhausted' });
    const snapshot = await store.snapshot(tenantA, executionId);
    expect(snapshot?.status).toBe('failed');
    expect(snapshot?.leaseAgentId).toBeNull();
    expect((await store.events(tenantA, executionId)).map((e) => e.eventType)).toContain('retry_exhausted');
  });

  it('a cancellation requested while a worker holds the lease is honoured at its next fenced write', async () => {
    const executionId = await newExecution();
    const fence = await claimAsOrchestrator(executionId);
    await delegateToTriage(fence);
    const requested = await store.requestCancel(tenantA, executionId, 'operator-digest', 'operator request');
    expect(requested).toEqual({ ok: true, value: { state: 'cancel_requested' } });
    expect(await store.recordDelegation(fence, { parentSeq: null, to: 'reviewer', requestedScopes: ['case:read'] }))
      .toEqual({ ok: false, reason: 'cancel_requested' });
    const done = await store.release(fence, 'cancelled', 'cancel_requested');
    expect(done).toEqual({ ok: true, value: { status: 'cancelled' } });
    const snapshot = await store.snapshot(tenantA, executionId);
    expect(snapshot?.status).toBe('cancelled');
    expect(await store.claim({ tenantId: tenantA, executionId, spiffeId: SPIFFE.orchestrator, instance: 'orchestrator-2', leaseSeconds: 30 }))
      .toEqual({ ok: false, reason: 'terminal' });
  });

  it('a cancellation with no lease holder takes effect immediately and revokes open grants', async () => {
    const executionId = await newExecution();
    const fence = await claimAsOrchestrator(executionId);
    const envelope = await (async () => {
      await delegateToTriage(fence);
      const args = { caseRef: 'synthetic-9' };
      await store.issueGrant(fence, { chainSeq: 1, kind: 'request', action: 'triage.classify', argumentsDigest: argsDigest(args), requiredScopes: ['case:read'] });
      return envelopeFor({ executionId, tenantId: tenantA, principal, from: 'orchestrator', to: 'triage', chain: rootToTriage(), action: 'triage.classify', args });
    })();
    await store.release(fence, 'pending', 'worker_stopped');
    expect(await store.requestCancel(tenantA, executionId, 'operator-digest', 'operator request')).toEqual({ ok: true, value: { state: 'cancelled' } });
    expect((await store.grants(tenantA, executionId)).every((g) => g.status === 'revoked')).toBe(true);
    expect(await store.consumeEnvelope(fence, envelope)).toEqual({ ok: false, reason: 'stale_fence' });
  });

  it('renewal extends the lease for the current holder only', async () => {
    const executionId = await newExecution();
    const fence = await claimAsOrchestrator(executionId);
    expect((await store.renew(fence, 60)).ok).toBe(true);
    expect(await store.renew({ ...fence, fencingToken: 99 }, 60)).toEqual({ ok: false, reason: 'stale_fence' });
  });
});

describe('tenant isolation and least privilege in the database', () => {
  it('another tenant cannot see, fence, or act on an execution it does not own', async () => {
    const executionId = await newExecution({ tenantId: tenantA });
    const fence = await claimAsOrchestrator(executionId);
    expect(await store.snapshot(tenantB, executionId)).toBeNull();
    expect(await store.delegations(tenantB, executionId)).toEqual([]);
    expect(await store.events(tenantB, executionId)).toEqual([]);
    const crossFence = { ...fence, tenantId: tenantB };
    expect(await store.recordDelegation(crossFence, { parentSeq: null, to: 'triage', requestedScopes: ['case:read'] }))
      .toEqual({ ok: false, reason: 'not_found' });
  });

  it('a grant created for one tenant cannot be consumed under another tenant', async () => {
    const executionId = await newExecution({ tenantId: tenantA });
    const fence = await claimAsOrchestrator(executionId);
    const envelope = await (async () => {
      await delegateToTriage(fence);
      const args = { caseRef: 'synthetic-tenant' };
      await store.issueGrant(fence, { chainSeq: 1, kind: 'request', action: 'triage.classify', argumentsDigest: argsDigest(args), requiredScopes: ['case:read'] });
      return envelopeFor({ executionId, tenantId: tenantA, principal, from: 'orchestrator', to: 'triage', chain: rootToTriage(), action: 'triage.classify', args });
    })();
    const replayUnderB = await store.consumeEnvelope({ ...fence, tenantId: tenantB }, { ...envelope, tenantId: tenantB });
    expect(replayUnderB).toEqual({ ok: false, reason: 'not_found' });
    expect((await store.grants(tenantA, executionId))[0].status).toBe('open');
  });

  it('a tenant cannot insert an execution into another tenant, even with a valid runtime connection', async () => {
    await expect(runTenant(tenantA, (client) => client.query(
      `INSERT INTO aegis.agent_executions (tenant_id, idempotency_key, principal_ref, principal_scopes, root_agent, max_depth, max_delegations,
         max_steps, grant_ttl_seconds, max_attempts) VALUES ($1, 'cross', $2, ARRAY['case:read'], 'orchestrator', 2, 1, 1, 60, 1)`,
      [tenantB, principal]))).rejects.toThrow(/row-level security/);
  });

  it('the runtime role cannot rewrite the agent catalogue, the audit trail, or an execution\'s ceilings', async () => {
    const executionId = await newExecution();
    await expect(runTenant(tenantA, (client) => client.query(
      "UPDATE aegis.agent_registrations SET registered_scopes = ARRAY['case:write'] WHERE agent_id = 'triage'", []))).rejects.toThrow(/permission denied/);
    await expect(runTenant(tenantA, (client) => client.query(
      "INSERT INTO aegis.agent_registrations (agent_id, spiffe_id, role, registered_scopes) VALUES ('rogue', 'spiffe://aegis.local/workload/rogue', 'triage', ARRAY[]::text[])", [])))
      .rejects.toThrow(/permission denied/);
    await expect(runTenant(tenantA, (client) => client.query(
      "UPDATE aegis.agent_executions SET max_steps = 500 WHERE execution_id = $1", [executionId]))).rejects.toThrow(/permission denied/);
    await expect(runTenant(tenantA, (client) => client.query(
      "UPDATE aegis.agent_execution_events SET outcome = 'accepted' WHERE execution_id = $1", [executionId]))).rejects.toThrow(/permission denied/);
    await expect(runTenant(tenantA, (client) => client.query(
      'DELETE FROM aegis.agent_execution_events WHERE execution_id = $1', [executionId]))).rejects.toThrow(/permission denied/);
  });

  it('the runtime role cannot bypass row level security or read the other tenant rows directly', async () => {
    const executionId = await newExecution({ tenantId: tenantA });
    const seen = await runTenant(tenantB, (client) => client.query('SELECT execution_id FROM aegis.agent_executions WHERE execution_id = $1', [executionId]));
    expect(seen.rows).toEqual([]);
    const role = await pool.query<{ rolsuper: boolean; rolbypassrls: boolean; current_user: string }>(
      'SELECT rolsuper, rolbypassrls, current_user FROM pg_roles WHERE rolname = current_user');
    expect(role.rows[0]).toEqual({ rolsuper: false, rolbypassrls: false, current_user: 'aegis_app' });
  });

  it('every agent table has forced row level security, so the owner is also governed', async () => {
    const result = await admin.query<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>(
      `SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname LIKE 'agent\\_%' AND relkind = 'r' ORDER BY relname`);
    expect(result.rows.length).toBe(5);
    expect(result.rows.every((r) => r.relrowsecurity && r.relforcerowsecurity)).toBe(true);
  });
});

describe('telemetry hook', () => {
  it('reports each public decision once, with its operation, outcome, bounded reason, and whether it started or ended the execution', async () => {
    const seen: Array<{ operation: string; outcome: string; reason: string | null; started: boolean; terminal: boolean; executionId: string | null }> = [];
    const observed = createAgentExecutionStore(runTenant, { onDecision: (d) => seen.push({ operation: d.operation, outcome: d.outcome,
      reason: d.reason, started: d.started, terminal: d.terminal, executionId: d.executionId }) });
    const executionId = await newExecution();
    await observed.claim({ tenantId: tenantA, executionId, spiffeId: SPIFFE.triage, instance: 'triage-1', leaseSeconds: 30 });
    const claim = await observed.claim({ tenantId: tenantA, executionId, spiffeId: SPIFFE.orchestrator, instance: 'orchestrator-1', leaseSeconds: 30 });
    expect(claim.ok).toBe(true);
    if (!claim.ok) return;
    const fence: Fence = { tenantId: tenantA, executionId, agentId: 'orchestrator', instance: 'orchestrator-1', fencingToken: claim.value.fencingToken };
    await observed.release(fence, 'succeeded', 'done');
    expect(seen).toEqual([
      { operation: 'claim', outcome: 'refused', reason: 'not_orchestrator', started: false, terminal: false, executionId },
      { operation: 'claim', outcome: 'accepted', reason: null, started: true, terminal: false, executionId },
      { operation: 'release', outcome: 'accepted', reason: null, started: false, terminal: true, executionId },
    ]);
  });
});

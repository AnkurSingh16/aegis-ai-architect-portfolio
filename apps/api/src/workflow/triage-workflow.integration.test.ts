import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { createDefaultToolDispatcher } from '../agents/default-tools.js';
import { createDatabasePool } from '../storage/database.js';
import { migrateDatabase } from '../storage/migrations.js';
import { createPostgresApprovalStore, type TenantQueryable } from '../security/tool-approval-store.js';
import { createDurableStore } from './durable-store.js';
import { runTriageWorkflow } from './triage-workflow.js';

// Real PostgreSQL checks: the triage tool running as a durable, authorised execution.
const adminUrl = process.env.TEST_DATABASE_ADMIN_URL;
const runtimeUrl = process.env.TEST_DATABASE_URL;
if (!adminUrl || !runtimeUrl) throw new Error('Set TEST_DATABASE_ADMIN_URL and TEST_DATABASE_URL for real PostgreSQL tests.');

const admin = new Pool({ connectionString: adminUrl, max: 1 });
const pool = createDatabasePool(runtimeUrl, 4);
const tenantA = randomUUID();
const tenantB = randomUUID();
const at = (ms: number) => new Date(Date.UTC(2026, 10, 19, 10, 0, 0) + ms);
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
const dispatcher = createDefaultToolDispatcher(createPostgresApprovalStore(runTenant));
const issuer = 'https://issuer.example.test/';

function input(tenantId: string, args: Record<string, unknown>, scopes = ['read:cases'], key = `triage-${randomUUID()}`) {
  return {
    store, dispatcher, tenantId, idempotencyKey: key, args,
    principal: { issuer, subject: 'user-1', scopes: new Set(scopes) }, owner: 'worker-1', policy, leaseMs: 5000, timeoutMs: 2000, clock: () => at(0),
  };
}

beforeAll(async () => {
  await migrateDatabase(adminUrl, process.env.DATABASE_APP_PASSWORD ?? '', process.env.DATABASE_INGEST_PASSWORD ?? '');
  await admin.query("INSERT INTO aegis.tenants (id, name) VALUES ($1, 'Synthetic North'), ($2, 'Synthetic South')", [tenantA, tenantB]);
});

afterAll(async () => {
  await pool.end();
  await admin.end();
});

describe('triage tool as a durable, authorised execution', () => {
  it('returns the fixture output and records a successful execution', async () => {
    const result = await runTriageWorkflow(input(tenantA, { caseId: 'SYNTHETIC-LOGIN-001' }));
    expect(result.driver).toEqual({ status: 'succeeded', attempt: 1 });
    expect(result.output).toMatchObject({ caseId: 'SYNTHETIC-LOGIN-001', category: 'incident', priority: 'high' });
    const loaded = await store.load(result.executionId, tenantA);
    expect(loaded?.checkpoints.map((c) => c.state)).toEqual(['running', 'succeeded']);
  });

  it('fails permanently and returns no output when policy denies the call', async () => {
    const result = await runTriageWorkflow(input(tenantA, { caseId: 'SYNTHETIC-LOGIN-001' }, []));
    expect(result.driver).toEqual({ status: 'failed', attempt: 1, errorClass: 'permanent' });
    expect(result.output).toBeUndefined();
    expect((await store.load(result.executionId, tenantA))?.execution.state).toBe('failed');
  });

  it('refuses tenant crossing inside arguments without retrying', async () => {
    const result = await runTriageWorkflow(input(tenantA, { caseId: 'SYNTHETIC-LOGIN-001', tenantId: tenantB }));
    expect(result.driver).toEqual({ status: 'failed', attempt: 1, errorClass: 'permanent' });
    expect(result.output).toBeUndefined();
  });

  it('fails permanently for an unknown case id', async () => {
    const result = await runTriageWorkflow(input(tenantA, { caseId: 'NOT-A-CASE' }));
    expect(result.driver).toEqual({ status: 'failed', attempt: 1, errorClass: 'permanent' });
  });

  it('is idempotent: the same key returns the same execution, and a completed one is not run again', async () => {
    const key = `same-${randomUUID()}`;
    const first = await runTriageWorkflow(input(tenantA, { caseId: 'SYNTHETIC-BILLING-002' }, ['read:cases'], key));
    const second = await runTriageWorkflow(input(tenantA, { caseId: 'SYNTHETIC-BILLING-002' }, ['read:cases'], key));
    expect(second.executionId).toBe(first.executionId);
    expect(second.created).toBe(false);
    expect(second.driver).toEqual({ status: 'not_claimable' });
    expect(second.output).toBeUndefined();
  });

  it('does not expose another tenant\'s execution', async () => {
    const result = await runTriageWorkflow(input(tenantA, { caseId: 'SYNTHETIC-GUIDANCE-003' }));
    expect(await store.load(result.executionId, tenantB)).toBeUndefined();
  });
});

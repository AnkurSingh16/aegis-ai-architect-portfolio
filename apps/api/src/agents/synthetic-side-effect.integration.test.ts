import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { createDatabasePool } from '../storage/database.js';
import { migrateDatabase } from '../storage/migrations.js';
import { createPostgresApprovalStore, type TenantQueryable } from '../security/tool-approval-store.js';
import { actionDigest, type AgentRegistration, type RequestContext, type ToolDefinition, ToolGateway, verifiedRequestContext } from '../security/tool-policy-gateway.js';
import { createToolDispatcher, type ToolHandler } from './tool-dispatcher.js';
import { createTestAuthentication } from '../auth/test-authentication.js';

// An ISOLATED SYNTHETIC side-effecting action, used only to prove the approval path end to end. The "sink" is an array that
// lives in this test file. Nothing here reaches an external system, a customer record or a production store. No real action
// is authorised or performed. The tool is not registered in production code.
const adminUrl = process.env.TEST_DATABASE_ADMIN_URL;
const runtimeUrl = process.env.TEST_DATABASE_URL;
if (!adminUrl || !runtimeUrl) throw new Error('Set TEST_DATABASE_ADMIN_URL and TEST_DATABASE_URL for real PostgreSQL tests.');

const admin = new Pool({ connectionString: adminUrl, max: 2 });
const pool = createDatabasePool(runtimeUrl, 6);
const tenantA = randomUUID();
const tenantB = randomUUID();
const TOOL = 'synthetic.note.write';
const REQUESTER = 'requester-1';
const REVIEWER = 'reviewer-2';
const T0 = new Date('2026-11-20T09:00:00.000Z');
const LIFETIME_MS = 60_000;

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

const approvals = createPostgresApprovalStore(runTenant);
const sink: string[] = [];
let failNextRun = false;

const definitions: ToolDefinition[] = [{ name: TOOL, requiredScopes: ['write:cases'], sideEffect: 'write', requiresApproval: true }];
const agents: AgentRegistration[] = [{ agentId: 'synthetic-writer', active: true, scopes: ['write:cases'] }];
const handler: ToolHandler<{ note: string }, number> = {
  validate(args) {
    if (typeof args.note !== 'string' || args.note.length === 0 || args.note.length > 80) throw new Error('note must be 1 to 80 characters');
    return { note: args.note };
  },
  run({ note }) {
    if (failNextRun) { failNextRun = false; throw new Error('synthetic transient failure'); }
    sink.push(note);
    return sink.length;
  },
};
const gateway = new ToolGateway(new Map(definitions.map((d) => [d.name, d])), new Map(agents.map((a) => [a.agentId, a])), approvals);
const dispatcher = createToolDispatcher(gateway, new Map([[TOOL, handler as ToolHandler<unknown, unknown>]]));

const auth = await createTestAuthentication();
const context = async (tenantId: string, now: Date, subject = REQUESTER): Promise<RequestContext> =>
  verifiedRequestContext(await auth.principal(subject, ['write:cases']), { tenantId, agentId: 'synthetic-writer', now });

async function request(note: string, tenantId = tenantA, now = T0, approvalId?: string) {
  return dispatcher.dispatch({ toolName: TOOL, arguments: { note }, ...(approvalId ? { approvalId } : {}) }, await context(tenantId, now));
}

async function approvalFor(note: string, tenantId = tenantA, expiresAt = new Date(T0.getTime() + LIFETIME_MS)): Promise<string> {
  return approvals.create({ tenantId, toolName: TOOL, actionDigest: actionDigest(tenantId, TOOL, { note }), requestedBy: REQUESTER, expiresAt });
}

beforeAll(async () => {
  await migrateDatabase(adminUrl, process.env.DATABASE_APP_PASSWORD ?? '', process.env.DATABASE_INGEST_PASSWORD ?? '');
  await admin.query("INSERT INTO aegis.tenants (id, name) VALUES ($1, 'Synthetic North'), ($2, 'Synthetic South')", [tenantA, tenantB]);
});

afterAll(async () => {
  await Promise.all([pool.end(), admin.end()]);
});

describe('isolated synthetic side-effecting action through the approval system', () => {
  it('denies the action without an approval, and performs nothing', async () => {
    const result = await request('note-none');
    expect(result).toEqual({ status: 'denied', reasons: ['approval_required'] });
    expect(sink).not.toContain('note-none');
  });

  it('denies a pending approval, and performs nothing', async () => {
    const approvalId = await approvalFor('note-pending');
    expect(await request('note-pending', tenantA, T0, approvalId)).toEqual({ status: 'denied', reasons: ['approval_not_approved'] });
    expect(sink).not.toContain('note-pending');
  });

  it('rejects self-approval: the requester cannot approve their own action', async () => {
    const approvalId = await approvalFor('note-self');
    expect(await approvals.approve(approvalId, tenantA, REQUESTER, T0)).toBe(false);
    expect(await request('note-self', tenantA, T0, approvalId)).toEqual({ status: 'denied', reasons: ['approval_not_approved'] });
  });

  it('performs the action once an independent reviewer approves it, and single use prevents a replay', async () => {
    const approvalId = await approvalFor('note-ok');
    expect(await approvals.approve(approvalId, tenantA, REVIEWER, T0)).toBe(true);
    const first = await request('note-ok', tenantA, T0, approvalId);
    expect(first.status).toBe('ok');
    expect(sink).toEqual(['note-ok']);
    expect(await request('note-ok', tenantA, T0, approvalId)).toEqual({ status: 'denied', reasons: ['approval_consumed'] });
    expect(sink).toEqual(['note-ok']);
  });

  it('binds the approval to the exact action: the same approval cannot authorise different arguments', async () => {
    const approvalId = await approvalFor('note-bound');
    await approvals.approve(approvalId, tenantA, REVIEWER, T0);
    expect(await request('note-other', tenantA, T0, approvalId)).toEqual({ status: 'denied', reasons: ['approval_digest_mismatch'] });
    expect(sink).not.toContain('note-other');
    // The approval is still usable for the action it was issued for, because the mismatch consumed nothing.
    expect((await request('note-bound', tenantA, T0, approvalId)).status).toBe('ok');
  });

  it('denies an approval that has expired by the time it is used', async () => {
    const approvalId = await approvalFor('note-late', tenantA, new Date(T0.getTime() + 1000));
    await approvals.approve(approvalId, tenantA, REVIEWER, T0);
    expect(await request('note-late', tenantA, new Date(T0.getTime() + 5000), approvalId)).toEqual({ status: 'denied', reasons: ['approval_expired'] });
    expect(sink).not.toContain('note-late');
  });

  it('keeps tenants apart: another tenant cannot use an approval issued to this tenant', async () => {
    const approvalId = await approvalFor('note-tenant');
    await approvals.approve(approvalId, tenantA, REVIEWER, T0);
    const result = await request('note-tenant', tenantB, T0, approvalId);
    expect(result.status).toBe('denied');
    expect(sink).not.toContain('note-tenant');
    expect((await request('note-tenant', tenantA, T0, approvalId)).status).toBe('ok');
  });

  it('a failed run consumes its approval, so a retry needs a fresh approval (retry does not replay authority)', async () => {
    const approvalId = await approvalFor('note-retry');
    await approvals.approve(approvalId, tenantA, REVIEWER, T0);
    failNextRun = true;
    expect((await request('note-retry', tenantA, T0, approvalId)).status).toBe('error');
    expect(sink).not.toContain('note-retry');
    expect(await request('note-retry', tenantA, T0, approvalId)).toEqual({ status: 'denied', reasons: ['approval_consumed'] });
    const fresh = await approvalFor('note-retry');
    await approvals.approve(fresh, tenantA, REVIEWER, T0);
    expect((await request('note-retry', tenantA, T0, fresh)).status).toBe('ok');
    expect(sink.filter((n) => n === 'note-retry')).toHaveLength(1);
  });

  it('a rejected (withdrawn) approval cannot authorise the action, as on cancellation', async () => {
    const approvalId = await approvalFor('note-cancel');
    expect(await approvals.reject(approvalId, tenantA, T0)).toBe(true);
    expect(await request('note-cancel', tenantA, T0, approvalId)).toEqual({ status: 'denied', reasons: ['approval_not_approved'] });
    expect(sink).not.toContain('note-cancel');
  });
});

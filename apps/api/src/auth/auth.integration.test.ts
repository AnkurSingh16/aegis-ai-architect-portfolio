import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { Pool, type PoolClient } from 'pg';
import { createApp } from '../app.js';
import { CaseRepository } from '../storage/cases.js';
import { createDatabasePool, verifyRuntimeRole } from '../storage/database.js';
import { resolveFixture } from '../storage/config.js';
import { migrateDatabase } from '../storage/migrations.js';
import { withAuthenticatedTransaction } from './transaction.js';
import type { VerifiedPrincipal } from './token.js';
import { provisionMembership } from './memberships.js';

const adminUrl = process.env.TEST_DATABASE_ADMIN_URL;
const runtimeUrl = process.env.TEST_DATABASE_URL;
const password = process.env.DATABASE_APP_PASSWORD;
if (!adminUrl || !runtimeUrl || !password) throw new Error('Explicit PostgreSQL integration configuration is required.');
if (new URL(adminUrl).pathname !== '/aegis_test' || new URL(runtimeUrl).pathname !== '/aegis_test') {
  throw new Error('Authenticated integration tests require the isolated aegis_test database.');
}
const issuer = 'https://synthetic.auth0.example/';
const audience = 'https://aegis.synthetic.example/api';
const north = resolveFixture('north');
const south = resolveFixture('south');
const prefix = `synthetic-qa-${randomUUID()}`;
const operator = `${prefix}|operator`;
const reader = `${prefix}|reader`;
const other = `${prefix}|south`;
const admin = new Pool({ connectionString: adminUrl, max: 1 });
const pool = createDatabasePool(runtimeUrl, 4);
let app: ReturnType<typeof createApp>;
let key: Awaited<ReturnType<typeof generateKeyPair>>;
let northId: string;
let southId: string;
let errorLog: ReturnType<typeof vi.spyOn>;
let successLog: ReturnType<typeof vi.spyOn>;

function principal(subject = operator, scopes = ['read:cases', 'write:cases']): VerifiedPrincipal {
  return { issuer, subject, scopes: new Set(scopes) };
}
async function token(subject = operator, scope = 'read:cases write:cases', extra = {}) {
  return `Bearer ${await new SignJWT({ iss: issuer, aud: audience, sub: subject,
    exp: Math.floor(Date.now() / 1000) + 300, scope, ...extra })
    .setProtectedHeader({ alg: 'RS256', kid: 'integration' }).sign(key.privateKey)}`;
}
const casePath = (tenant = north.tenantId, id?: string) => `/api/tenants/${tenant}/cases${id ? `/${id}` : ''}`;
async function membership(subject: string, tenant: string, role: string) {
  await admin.query(`INSERT INTO aegis.memberships (issuer, subject, tenant_id, role) VALUES ($1, $2, $3, $4)
    ON CONFLICT (issuer, subject, tenant_id) DO UPDATE SET role = EXCLUDED.role`, [issuer, subject, tenant, role]);
}
beforeAll(async () => {
  errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
  successLog = vi.spyOn(console, 'info').mockImplementation(() => {});
  await migrateDatabase(adminUrl, password);
  await verifyRuntimeRole(pool);
  await membership(operator, north.tenantId, 'operator');
  await membership(reader, north.tenantId, 'reader');
  await membership(other, south.tenantId, 'operator');
  northId = (await new CaseRepository(pool, north, () => {}).create('SYNTHETIC-LOGIN-001')).id;
  southId = (await new CaseRepository(pool, south, () => {}).create('SYNTHETIC-BILLING-002')).id;
  key = await generateKeyPair('RS256');
  app = createApp({ authConfig: { issuer, audience, databaseUrl: runtimeUrl },
    testDependencies: { pool: createDatabasePool(runtimeUrl, 1),
      keyResolver: createLocalJWKSet({ keys: [{ ...await exportJWK(key.publicKey), kid: 'integration', alg: 'RS256' }] }) } });
  await app.ready();
}, 30000);
beforeEach(() => { errorLog?.mockClear(); successLog?.mockClear(); });
afterAll(async () => {
  if (app) await app.close();
  try { await admin.query('DELETE FROM aegis.memberships WHERE issuer = $1 AND subject LIKE $2', [issuer, `${prefix}|%`]); }
  finally { await Promise.all([pool.end(), admin.end()]); errorLog?.mockRestore(); successLog?.mockRestore(); }
});

describe('authenticated HTTP with real PostgreSQL membership authorization', () => {
  it('allows only the local administrator helper to grant and revoke fixture memberships', async () => {
    const subject = `${prefix}|administrator-helper`;
    const command = { action: 'grant' as const, issuer, subject, tenantId: north.tenantId, role: 'reader' as const };
    await expect(provisionMembership(runtimeUrl, command)).rejects.toThrow('Administrator credentials');
    await provisionMembership(adminUrl, command);
    expect((await app.inject({ url: casePath(), headers: { authorization: await token(subject) } })).statusCode).toBe(200);
    await provisionMembership(adminUrl, { ...command, action: 'revoke' });
    expect((await app.inject({ url: casePath(), headers: { authorization: await token(subject) } })).statusCode).toBe(403);
  });
  it('supports authorized list/read/create/update with persistent atomic audit records', async () => {
    const authorization = await token();
    const listed = await app.inject({ url: casePath(), headers: { authorization } });
    expect(listed.statusCode).toBe(200);
    expect(listed.json().every((row: { tenant_id: string }) => row.tenant_id === north.tenantId)).toBe(true);
    expect((await app.inject({ url: casePath(north.tenantId, northId), headers: { authorization } })).statusCode).toBe(200);
    const created = await app.inject({ method: 'POST', url: casePath(), headers: { authorization }, payload: { syntheticCaseId: 'SYNTHETIC-GUIDANCE-003' } });
    expect(created.statusCode).toBe(201); const id = created.json().id as string;
    const updated = await app.inject({ method: 'PATCH', url: `${casePath(north.tenantId, id)}/status`, headers: { authorization }, payload: { status: 'resolved' } });
    expect(updated.statusCode).toBe(200); expect(updated.json()).toMatchObject({ id, status: 'resolved', tenant_id: north.tenantId });
    expect(await new CaseRepository(pool, north, () => {}).audit(id)).toMatchObject([
      { action: 'case.created', new_status: 'open' }, { action: 'case.updated', previous_status: 'open', new_status: 'resolved' },
    ]);
  });

  it('requires a valid bearer token and does not use development fixture identity for HTTP', async () => {
    const reply = await app.inject(casePath());
    expect(reply.statusCode).toBe(401); expect(reply.json()).toEqual({ error: 'Authentication required.' });
    expect(reply.headers['www-authenticate']).toBe('Bearer');
    expect((await app.inject({ url: casePath(), headers: { authorization: await token(`${prefix}|no-membership`) } })).statusCode).toBe(403);
  });

  it('intersects exact token scopes and database roles without trusting token roles or permissions', async () => {
    const readerAuth = await token(reader, 'read:cases write:cases', { roles: ['operator'], permissions: ['write:cases'], tenant_id: north.tenantId });
    expect((await app.inject({ url: casePath(), headers: { authorization: readerAuth } })).statusCode).toBe(200);
    for (const authorization of [readerAuth, await token(operator, 'read:cases'), await token(operator, 'prefixwrite:cases write:cases:extra')]) {
      expect((await app.inject({ method: 'POST', url: casePath(), headers: { authorization }, payload: { syntheticCaseId: 'SYNTHETIC-LOGIN-001' } })).statusCode).toBe(403);
    }
    expect((await app.inject({ url: casePath(), headers: { authorization: await token(operator, 'write:cases') } })).statusCode).toBe(403);
  });

  it('denies cross-tenant URL selection and treats foreign case IDs as neutral404', async () => {
    const authorization = await token();
    for (const request of [
      { method: 'GET' as const, url: casePath(south.tenantId) },
      { method: 'POST' as const, url: casePath(south.tenantId), payload: { syntheticCaseId: 'SYNTHETIC-LOGIN-001' } },
      { method: 'PATCH' as const, url: `${casePath(south.tenantId, southId)}/status`, payload: { status: 'resolved' } },
    ]) expect((await app.inject({ ...request, headers: { authorization, 'x-tenant-id': north.tenantId } })).statusCode).toBe(403);
    const read = await app.inject({ url: casePath(north.tenantId, southId), headers: { authorization } });
    const update = await app.inject({ method: 'PATCH', url: `${casePath(north.tenantId, southId)}/status`, headers: { authorization }, payload: { status: 'resolved' } });
    expect(read.statusCode).toBe(404); expect(update.statusCode).toBe(404);
    expect(read.json()).toEqual({ error: 'Case not found.' });
    expect((await new CaseRepository(pool, south, () => {}).read(southId)).status).toBe('open');
  });

  it('does not accept tenant authorization from headers, query parameters or request bodies', async () => {
    const authorization = await token();
    const read = await app.inject({ url: casePath(north.tenantId, northId), headers: { authorization, 'x-tenant-id': south.tenantId, 'x-user-id': other } });
    expect(read.statusCode).toBe(200); expect(read.json().tenant_id).toBe(north.tenantId);
    expect((await app.inject({ url: `${casePath()}?tenantId=${south.tenantId}`, headers: { authorization } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: casePath(), headers: { authorization }, payload: { syntheticCaseId: 'SYNTHETIC-LOGIN-001', tenantId: south.tenantId } })).statusCode).toBe(400);
  });

  it('applies membership revocation and role downgrade on the next transaction after admin commit', async () => {
    const subject = `${prefix}|revoked`; await membership(subject, north.tenantId, 'operator');
    const authorization = await token(subject);
    expect((await app.inject({ url: casePath(), headers: { authorization } })).statusCode).toBe(200);
    await membership(subject, north.tenantId, 'reader');
    expect((await app.inject({ method: 'POST', url: casePath(), headers: { authorization }, payload: { syntheticCaseId: 'SYNTHETIC-LOGIN-001' } })).statusCode).toBe(403);
    expect((await app.inject({ url: casePath(), headers: { authorization } })).statusCode).toBe(200);
    await admin.query('DELETE FROM aegis.memberships WHERE issuer=$1 AND subject=$2', [issuer, subject]);
    expect((await app.inject({ url: casePath(), headers: { authorization } })).statusCode).toBe(403);
  });

  it('keeps in-flight membership snapshot consistent and denies the following revoked request', async () => {
    const subject = `${prefix}|snapshot`; await membership(subject, north.tenantId, 'reader');
    await withAuthenticatedTransaction(pool, principal(subject), north.tenantId, 'read:cases', async (client) => {
      await admin.query('DELETE FROM aegis.memberships WHERE issuer=$1 AND subject=$2', [issuer, subject]);
      expect((await client.query('SHOW transaction_isolation')).rows[0].transaction_isolation).toBe('repeatable read');
      expect((await client.query('SELECT role FROM aegis.memberships WHERE tenant_id=$1', [north.tenantId])).rows).toEqual([{ role: 'reader' }]);
      expect((await client.query('SELECT id FROM aegis.support_cases WHERE id=$1', [northId])).rows).toEqual([{ id: northId }]);
    });
    await expect(withAuthenticatedTransaction(pool, principal(subject), north.tenantId, 'read:cases', async () => null))
      .rejects.toMatchObject({ status: 403 });
  });

  it('keeps authenticated operations available after rollback on a reused single-connection HTTP pool', async () => {
    const authorization = await token();
    const foreign = await app.inject({ url: casePath(north.tenantId, southId), headers: { authorization } });
    expect(foreign.statusCode).toBe(404);
    const next = await app.inject({ url: casePath(south.tenantId, southId), headers: { authorization: await token(other) } });
    expect(next.statusCode).toBe(200); expect(next.json().tenant_id).toBe(south.tenantId);
    expect((await app.inject(casePath())).statusCode).toBe(401);
  });

  it('never logs bearer tokens, verified subjects, request bodies or database credentials', async () => {
    const authorization = await token(`${prefix}|not-authorized`);
    const reply = await app.inject({ method: 'POST', url: casePath(), headers: { authorization }, payload: { syntheticCaseId: 'SYNTHETIC-LOGIN-001', privateText: 'BODY-MUST-NOT-LOG' } });
    expect(reply.statusCode).toBe(400);
    const logged = `${JSON.stringify(errorLog.mock.calls)} ${JSON.stringify(successLog.mock.calls)} ${reply.body}`;
    for (const value of [authorization, prefix, 'BODY-MUST-NOT-LOG', password, adminUrl, runtimeUrl]) expect(logged).not.toContain(value);
  });
});

async function rawContext(context: { mode?: string; issuer?: string; subject?: string; tenant?: string }, operation: (client: PoolClient) => Promise<unknown>) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT set_config('aegis.access_mode',$1,true), set_config('aegis.principal_issuer',$2,true),
      set_config('aegis.principal_subject',$3,true), set_config('aegis.tenant_id',$4,true)`,
    [context.mode ?? '', context.issuer ?? '', context.subject ?? '', context.tenant ?? north.tenantId]);
    return await operation(client);
  } finally { await client.query('ROLLBACK'); client.release(); }
}
describe('authenticated Row-Level Security independently enforces membership', () => {
  it('rejects runtime credential privilege drift from a column-level membership UPDATE grant', async () => {
    await verifyRuntimeRole(pool);
    try {
      await admin.query('GRANT UPDATE (role) ON aegis.memberships TO aegis_app');
      await expect(verifyRuntimeRole(pool)).rejects.toThrow('Unsafe application database role or schema.');
    } finally { await admin.query('REVOKE UPDATE (role) ON aegis.memberships FROM aegis_app'); }
    await expect(verifyRuntimeRole(pool)).resolves.toBeUndefined();
  });
  it('does not authorize a tenant GUC alone, missing principal or mismatched issuer/subject', async () => {
    for (const context of [{}, { mode: 'authenticated' }, { mode: 'authenticated', issuer, subject: `${prefix}|unknown` },
      { mode: 'authenticated', issuer: 'https://other-issuer.example/', subject: operator }]) {
      await rawContext(context, async (client) => {
        expect((await client.query('SELECT * FROM aegis.support_cases')).rows).toEqual([]);
        expect((await client.query('SELECT * FROM aegis.memberships')).rows).toEqual([]);
      });
      await expect(rawContext(context, (client) => client.query('INSERT INTO aegis.support_cases (tenant_id,synthetic_case_id) VALUES($1,$2)',
        [north.tenantId, 'SYNTHETIC-LOGIN-001']))).rejects.toMatchObject({ code: '42501' });
    }
  });

  it('keeps memberships SELECT-only and visible solely to the matching verified identity', async () => {
    await rawContext({ mode: 'authenticated', issuer, subject: reader }, async (client) => {
      const memberships = await client.query('SELECT issuer,subject,tenant_id,role FROM aegis.memberships');
      expect(memberships.rows).toEqual([{ issuer, subject: reader, tenant_id: north.tenantId, role: 'reader' }]);
    });
    for (const sql of [
      'INSERT INTO aegis.memberships(issuer,subject,tenant_id,role) VALUES($1,$2,$3,\'operator\')',
      'UPDATE aegis.memberships SET role=\'operator\' WHERE issuer=$1 AND subject=$2 AND tenant_id=$3',
      'DELETE FROM aegis.memberships WHERE issuer=$1 AND subject=$2 AND tenant_id=$3',
    ]) await expect(rawContext({ mode: 'authenticated', issuer, subject: reader }, (client) => client.query(sql, [issuer, reader, north.tenantId])))
      .rejects.toMatchObject({ code: '42501' });
  });

  it('denies reader writes and operator cross-tenant SQL inserts/updates without repository filters', async () => {
    await expect(rawContext({ mode: 'authenticated', issuer, subject: reader }, (client) => client.query(
      'INSERT INTO aegis.support_cases(tenant_id,synthetic_case_id) VALUES($1,$2)', [north.tenantId, 'SYNTHETIC-LOGIN-001'])))
      .rejects.toMatchObject({ code: '42501' });
    await expect(rawContext({ mode: 'authenticated', issuer, subject: reader }, (client) => client.query(
      'UPDATE aegis.support_cases SET status=\'resolved\' WHERE id=$1', [northId]))).rejects.toMatchObject({ code: '42501' });
    await rawContext({ mode: 'authenticated', issuer, subject: operator }, async (client) => {
      expect((await client.query('SELECT * FROM aegis.support_cases WHERE id=$1', [southId])).rows).toEqual([]);
      expect((await client.query('SELECT * FROM aegis.audit_events WHERE case_id=$1', [southId])).rows).toEqual([]);
      expect((await client.query('UPDATE aegis.support_cases SET status=\'resolved\' WHERE id=$1', [southId])).rowCount).toBe(0);
    });
    await expect(rawContext({ mode: 'authenticated', issuer, subject: operator, tenant: south.tenantId }, (client) => client.query(
      'INSERT INTO aegis.support_cases(tenant_id,synthetic_case_id) VALUES($1,$2)', [south.tenantId, 'SYNTHETIC-LOGIN-001'])))
      .rejects.toMatchObject({ code: '42501' });
  });

  it('rolls back case writes and audit records with authenticated context and clears pooled principal state', async () => {
    let rolledBackId: string | undefined;
    await expect(withAuthenticatedTransaction(pool, principal(), north.tenantId, 'write:cases', async (client) => {
      rolledBackId = (await client.query('INSERT INTO aegis.support_cases(tenant_id,synthetic_case_id) VALUES($1,$2) RETURNING id',
        [north.tenantId, 'SYNTHETIC-LOGIN-001'])).rows[0].id;
      throw new Error('rollback requested');
    })).rejects.toThrow('rollback requested');
    expect((await admin.query('SELECT id FROM aegis.support_cases WHERE id=$1', [rolledBackId])).rows).toEqual([]);
    expect((await admin.query('SELECT id FROM aegis.audit_events WHERE case_id=$1', [rolledBackId])).rows).toEqual([]);
    expect((await pool.query('SELECT * FROM aegis.memberships')).rows).toEqual([]);
    expect((await pool.query('SELECT * FROM aegis.support_cases')).rows).toEqual([]);
  });

  it('isolates concurrent authenticated principal and tenant transactions', async () => {
    await Promise.all(Array.from({ length: 12 }, (_, index) => {
      const fixture = index % 2 ? north : south;
      const identity = index % 2 ? operator : other;
      return withAuthenticatedTransaction(pool, principal(identity), fixture.tenantId, 'read:cases', async (client) => {
        await client.query('SELECT pg_sleep(0.01)');
        expect((await client.query('SELECT id FROM aegis.tenants')).rows).toEqual([{ id: fixture.tenantId }]);
        const memberships = await client.query('SELECT subject FROM aegis.memberships');
        expect(memberships.rows.every((row) => row.subject === identity)).toBe(true);
      });
    }));
    expect((await pool.query('SELECT * FROM aegis.memberships')).rows).toEqual([]);
  });
});

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { resolveFixture } from './config.js';
import { createDatabasePool } from './database.js';
import { migrateDatabase } from './migrations.js';
import { withAuthenticatedTransaction } from '../auth/transaction.js';

// Migration 020 (remediation 1): the application runtime role must not reach another tenant through the session setting that used to
// enable a fixture bypass. Every test below uses a real PostgreSQL role and real session settings. No query is mocked.

const adminUrl = process.env.TEST_DATABASE_ADMIN_URL;
const runtimeUrl = process.env.TEST_DATABASE_URL;
const password = process.env.DATABASE_APP_PASSWORD;
const ingestionPassword = process.env.DATABASE_INGEST_PASSWORD;
if (!adminUrl || !runtimeUrl || !password || !ingestionPassword) throw new Error('Set isolated PostgreSQL test URLs and role passwords for real PostgreSQL tests.');
for (const value of [adminUrl, runtimeUrl]) {
  const parsed = new URL(value);
  if (parsed.pathname !== '/aegis_test' || !['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname)) {
    throw new Error('Integration connections must target loopback aegis_test.');
  }
}

const north = resolveFixture('north');
const south = resolveFixture('south');
const issuer = 'https://fixture-boundary.synthetic.example/';
const memberSubject = `fixture-boundary|north-member-${randomUUID()}`;
const admin = new Pool({ connectionString: adminUrl, max: 1 });
const app = createDatabasePool(runtimeUrl, 2);
let northCaseId: string;
let southCaseId: string;

/** Inserts a case as the administrator with the tenant set in the same transaction, as the audit trigger requires. */
async function insertCase(tenant: string, caseId: string): Promise<string> {
  const client = await admin.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('aegis.tenant_id', $1, true)", [tenant]);
    const row = (await client.query<{ id: string }>(
      'INSERT INTO aegis.support_cases (tenant_id, synthetic_case_id) VALUES ($1, $2) RETURNING id', [tenant, caseId])).rows[0];
    await client.query('COMMIT');
    return row.id;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally { client.release(); }
}

beforeAll(async () => {
  await migrateDatabase(adminUrl, password, ingestionPassword);
  await admin.query(`INSERT INTO aegis.tenants (id, name) VALUES ($1, $2), ($3, $4) ON CONFLICT (id) DO NOTHING`,
    [north.tenantId, north.name, south.tenantId, south.name]);
  await admin.query(`INSERT INTO aegis.memberships (issuer, subject, tenant_id, role) VALUES ($1, $2, $3, 'reader')`,
    [issuer, memberSubject, north.tenantId]);
  northCaseId = await insertCase(north.tenantId, 'SYNTHETIC-LOGIN-001');
  southCaseId = await insertCase(south.tenantId, 'SYNTHETIC-BILLING-002');
});

afterAll(async () => {
  try {
    await admin.query('DELETE FROM aegis.memberships WHERE issuer = $1 AND subject = $2', [issuer, memberSubject]);
  } finally { await Promise.all([app.end(), admin.end()]); }
});

/** Runs SQL as the application login with the given session settings, in one transaction, and returns the rows of the last statement. */
async function asAppWith(settings: Record<string, string>, sql: string, values: unknown[] = []) {
  const client = await app.connect();
  try {
    await client.query('BEGIN');
    for (const [name, value] of Object.entries(settings)) {
      await client.query('SELECT set_config($1, $2, true)', [name, value]);
    }
    const result = await client.query(sql, values);
    await client.query('COMMIT');
    return result.rows;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally { client.release(); }
}

describe('migration 020: the application login cannot enable or use a fixture bypass', () => {
  it('a fixture session flag set by the application login reveals no case of another tenant, and none of its own tenant without membership', async () => {
    const rows = await asAppWith({ 'aegis.access_mode': 'fixture', 'aegis.tenant_id': north.tenantId },
      'SELECT id FROM aegis.support_cases');
    expect(rows).toEqual([]);
  });

  it('a fixture session flag cannot insert a case for a tenant the login does not belong to', async () => {
    await expect(asAppWith({ 'aegis.access_mode': 'fixture', 'aegis.tenant_id': north.tenantId },
      `INSERT INTO aegis.support_cases (tenant_id, synthetic_case_id) VALUES ($1, 'SYNTHETIC-GUIDANCE-003')`, [north.tenantId]))
      .rejects.toThrow(/row-level security/);
  });

  it('changing the session flags to a tenant the verified member does not belong to reveals no case (direct SQL, not the application helper)', async () => {
    const rows = await asAppWith({ 'aegis.access_mode': 'authenticated', 'aegis.principal_issuer': issuer,
      'aegis.principal_subject': memberSubject, 'aegis.tenant_id': south.tenantId }, 'SELECT id FROM aegis.support_cases');
    expect(rows.map((row) => row.id)).not.toContain(southCaseId);
    expect(rows).toEqual([]);
  });

  it('without any session flags the application login sees no case at all (no default allow)', async () => {
    expect(await asAppWith({}, 'SELECT id FROM aegis.support_cases')).toEqual([]);
  });

  it('the application login cannot switch to the fixture role', async () => {
    await expect(asAppWith({}, 'SET ROLE aegis_fixture')).rejects.toThrow(/permission denied to set role/);
  });

  it('the fixture role is not a login and has no membership in the runtime role', async () => {
    const roles = await admin.query<{ rolcanlogin: boolean; rolinherit: boolean }>(
      `SELECT rolcanlogin, rolinherit FROM pg_roles WHERE rolname = 'aegis_fixture'`);
    expect(roles.rows).toEqual([{ rolcanlogin: false, rolinherit: false }]);
    const memberships = await admin.query(`SELECT 1 FROM pg_auth_members WHERE roleid IN (SELECT oid FROM pg_roles WHERE rolname IN ('aegis_app', 'aegis_fixture')) OR member IN (SELECT oid FROM pg_roles WHERE rolname IN ('aegis_app', 'aegis_fixture'))`);
    expect(memberships.rows).toEqual([]);
  });
});

describe('migration 020: legitimate tenant operations keep working', () => {
  it('a verified member reads its own tenant case through the authenticated path', async () => {
    const rows = await withAuthenticatedTransaction(app, { issuer, subject: memberSubject, scopes: new Set(['read:cases']) },
      north.tenantId, 'read:cases', async (client) => (await client.query('SELECT id FROM aegis.support_cases')).rows);
    expect(rows.map((row) => row.id)).toContain(northCaseId);
    expect(rows.map((row) => row.id)).not.toContain(southCaseId);
  });

  it('the fixture role reads its own synthetic tenant case in fixture mode (synthetic persistence)', async () => {
    const fixtureAdmin = new Pool({ connectionString: adminUrl, max: 1 });
    const client = await fixtureAdmin.connect();
    try {
      await client.query('SET ROLE aegis_fixture');
      await client.query('BEGIN');
      await client.query(`SELECT set_config('aegis.access_mode', 'fixture', true), set_config('aegis.principal_issuer', '', true),
        set_config('aegis.principal_subject', '', true), set_config('aegis.tenant_id', $1, true)`, [north.tenantId]);
      const rows = (await client.query('SELECT id FROM aegis.support_cases')).rows;
      await client.query('COMMIT');
      expect(rows.map((row) => row.id)).toContain(northCaseId);
      expect(rows.map((row) => row.id)).not.toContain(southCaseId);
    } finally { client.release(); await fixtureAdmin.end(); }
  });
});

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { resolveFixture } from '../storage/config.js';
import { createDatabasePool } from '../storage/database.js';
import { migrateDatabase } from '../storage/migrations.js';
import { roleUrl } from '../orchestration/messaging/testing/support.js';
import { withMessagingContext } from '../orchestration/messaging/context.js';

// F3 BASELINE (Phase B1, step 3). These tests record the CURRENT, unremediated behaviour of the effective policies, reproduced on real
// PostgreSQL with the real runtime logins. An EXPOSURE test asserts what a caller can do today. It is not a statement that the behaviour is
// acceptable. After remediation these expectations are inverted, and the suite becomes a regression suite.
// Synthetic fixtures only. No credential is embedded; role URLs come from the CI environment.

const adminUrl = process.env.TEST_DATABASE_ADMIN_URL;
const runtimeUrl = process.env.TEST_DATABASE_URL;
const password = process.env.DATABASE_APP_PASSWORD;
const ingestionPassword = process.env.DATABASE_INGEST_PASSWORD;
if (!adminUrl || !runtimeUrl || !password || !ingestionPassword) throw new Error('Set isolated PostgreSQL test URLs and role passwords for real PostgreSQL tests.');

const north = resolveFixture('north');
const south = resolveFixture('south');
const issuer = 'https://f3-baseline.synthetic.example/';
const suffix = randomUUID();
const northMember = `f3-baseline|north-member-${suffix}`;
const southMember = `f3-baseline|south-member-${suffix}`;
const attacker = `f3-baseline|attacker-${suffix}`;
const admin = new Pool({ connectionString: adminUrl, max: 1 });
const app = createDatabasePool(runtimeUrl, 2);
const gateway = createDatabasePool(roleUrl('gateway'), 2);
let northCaseId: string;
let southCaseId: string;

/** Inserts one synthetic case. The identifier must be one of the three values allowed by migration 001 (no uniqueness on it). */
async function insertCase(tenant: string, syntheticCaseId: 'SYNTHETIC-LOGIN-001' | 'SYNTHETIC-BILLING-002'): Promise<string> {
  const client = await admin.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('aegis.tenant_id', $1, true)", [tenant]);
    const id = (await client.query<{ id: string }>(
      'INSERT INTO aegis.support_cases (tenant_id, synthetic_case_id) VALUES ($1, $2) RETURNING id', [tenant, syntheticCaseId])).rows[0].id;
    await client.query('COMMIT');
    return id;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally { client.release(); }
}

beforeAll(async () => {
  await migrateDatabase(adminUrl, password, ingestionPassword);
  await admin.query(`INSERT INTO aegis.tenants (id, name) VALUES ($1, $2), ($3, $4) ON CONFLICT (id) DO NOTHING`,
    [north.tenantId, north.name, south.tenantId, south.name]);
  // NORTH has one member (the victim). SOUTH has a member, but not the NORTH member. The attacker has no membership anywhere.
  await admin.query(`INSERT INTO aegis.memberships (issuer, subject, tenant_id, role) VALUES ($1, $2, $3, 'reader'), ($1, $4, $5, 'reader')`,
    [issuer, northMember, north.tenantId, southMember, south.tenantId]);
  northCaseId = await insertCase(north.tenantId, 'SYNTHETIC-LOGIN-001');
  southCaseId = await insertCase(south.tenantId, 'SYNTHETIC-BILLING-002');
});

afterAll(async () => {
  try {
    await admin.query('DELETE FROM aegis.memberships WHERE issuer = $1 AND subject = ANY($2)', [issuer, [northMember, southMember, attacker]]);
  } finally { await Promise.all([app.end(), gateway.end(), admin.end()]); }
});

/** Runs SQL as the application login with the given raw session settings, in one transaction, and returns the rows. */
async function asAppWith(settings: Record<string, string>, sql: string, values: unknown[] = []) {
  const client = await app.connect();
  try {
    await client.query('BEGIN');
    for (const [name, value] of Object.entries(settings)) await client.query('SELECT set_config($1, $2, true)', [name, value]);
    const result = await client.query(sql, values);
    await client.query('COMMIT');
    return result.rows as Array<{ id: string }>;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally { client.release(); }
}

const authenticated = (principal: string, tenant: string) => ({
  'aegis.access_mode': 'authenticated', 'aegis.principal_issuer': issuer, 'aegis.principal_subject': principal, 'aegis.tenant_id': tenant,
});
const ids = (rows: Array<{ id: string }>) => rows.map((row) => row.id);

describe('F3 baseline: the current exposure of the effective policies (aegis_app and aegis_gateway, real logins)', () => {
  it('B0 control: no session settings at all reveal no case (no default allow)', async () => {
    expect(await asAppWith({}, 'SELECT id FROM aegis.support_cases')).toEqual([]);
  });

  it('B1 TENANT CHANGE ONLY (control): a verified NORTH member, not a member of SOUTH, changes only the tenant and reads no SOUTH case', async () => {
    // Recorded result (run 46130642730): no row. The case policy's EXISTS subquery reads aegis.memberships, whose own policy
    // principal_memberships shows only rows for the session principal. So the tenant alone does not establish membership.
    const rows = await asAppWith(authenticated(northMember, south.tenantId), 'SELECT id FROM aegis.support_cases');
    expect(ids(rows)).not.toContain(southCaseId);
  });

  it('B2 PRINCIPAL FORGERY OF A REAL MEMBER (EXPOSURE, confirmed by run 46130642730): a session that is not the victim names the victim and the victim\'s tenant, and reads the case', async () => {
    // The database cannot tell this session from the victim's own. The subject needs no secret: membership rows are readable (see B3).
    const rows = await asAppWith(authenticated(northMember, north.tenantId), 'SELECT id FROM aegis.support_cases');
    expect(ids(rows)).toContain(northCaseId);
  });

  it('B3 GATEWAY MEMBERSHIP ENUMERATION (EXPOSURE): aegis_gateway reads every membership row of every tenant with no session principal', async () => {
    // Migration 018: membership_gateway_read USING (true). Application filtering is the only restriction.
    const subjects = await withMessagingContext(gateway, {}, (client) => client.query<{ subject: string }>(
      'SELECT subject FROM aegis.memberships WHERE issuer = $1', [issuer]).then((r) => r.rows.map((row) => row.subject)));
    expect(subjects).toEqual(expect.arrayContaining([northMember, southMember]));
  });

  it('B4 ACCESS MODE AND TENANT ONLY, no principal (control): no case is visible without a principal', async () => {
    const rows = await asAppWith({ 'aegis.access_mode': 'authenticated', 'aegis.tenant_id': north.tenantId }, 'SELECT id FROM aegis.support_cases');
    expect(ids(rows)).not.toContain(northCaseId);
  });

  it('B5 AUTHENTICATED ATTACKER WITH NO MEMBERSHIP (control): an identity with no membership reads no NORTH case by naming NORTH', async () => {
    const rows = await asAppWith(authenticated(attacker, north.tenantId), 'SELECT id FROM aegis.support_cases');
    expect(ids(rows)).not.toContain(northCaseId);
  });
});

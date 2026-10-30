import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import { CaseRepository } from './cases.js';
import { resolveFixture } from './config.js';
import { createDatabasePool, verifyRuntimeRole, withTenantTransaction } from './database.js';
import { migrateDatabase, migrationsDirectory } from './migrations.js';

// Integration tests deliberately fail without explicit, separate test database configuration.
const adminUrl = process.env.TEST_DATABASE_ADMIN_URL;
const runtimeUrl = process.env.TEST_DATABASE_URL;
const password = process.env.DATABASE_APP_PASSWORD;
if (!adminUrl || !runtimeUrl || !password) throw new Error('Set TEST_DATABASE_ADMIN_URL, TEST_DATABASE_URL and DATABASE_APP_PASSWORD for real PostgreSQL tests.');
if (new URL(adminUrl).pathname !== '/aegis_test' || new URL(runtimeUrl).pathname !== '/aegis_test') {
  throw new Error('Integration tests require the isolated aegis_test database.');
}
const north = resolveFixture('north');
const south = resolveFixture('south');
const log = vi.fn();
const pool = createDatabasePool(runtimeUrl, 4);
const single = createDatabasePool(runtimeUrl, 1);
const admin = new Pool({ connectionString: adminUrl, max: 1 });
const a = new CaseRepository(pool, north, log);
const b = new CaseRepository(pool, south, log);
let northId: string;
let southId: string;

beforeAll(async () => {
  await migrateDatabase(adminUrl, password);
  await verifyRuntimeRole(pool);
  northId = (await a.create('SYNTHETIC-LOGIN-001')).id;
  southId = (await b.create('SYNTHETIC-BILLING-002')).id;
}, 30000);
afterAll(async () => { await Promise.all([pool.end(), single.end(), admin.end()]); });

describe('real PostgreSQL persistence and role boundary', () => {
  it('replays migrations without changing the schema and rejects checksum changes', async () => {
    expect(await migrateDatabase(adminUrl, password)).toBe(0);
    const directory = await mkdtemp(join(tmpdir(), 'aegis-migrations-'));
    try {
      for (const file of await readdir(migrationsDirectory)) {
        await writeFile(join(directory, file), await readFile(new URL(file, migrationsDirectory), 'utf8'));
      }
      const sql = await readFile(new URL('001_multitenant.sql', migrationsDirectory), 'utf8');
      await writeFile(join(directory, '001_multitenant.sql'), `${sql}\n-- modified migration\n`);
      await expect(migrateDatabase(adminUrl, password, pathToFileURL(`${directory}/`))).rejects.toThrow('modified');
    } finally { await rm(directory, { recursive: true, force: true }); }
    expect(await migrateDatabase(adminUrl, password)).toBe(0);
  });

  it('rejects missing, duplicate and out-of-order migration histories', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'aegis-history-'));
    try {
      const url = pathToFileURL(`${directory}/`);
      await expect(migrateDatabase(adminUrl, password, url)).rejects.toThrow('present and unique');
      await writeFile(join(directory, '002_placeholder.sql'), 'SELECT 1;');
      await expect(migrateDatabase(adminUrl, password, url)).rejects.toThrow('missing');
      const sql = await readFile(new URL('001_multitenant.sql', migrationsDirectory), 'utf8');
      await writeFile(join(directory, '001_multitenant.sql'), sql);
      await writeFile(join(directory, '001_duplicate.sql'), 'SELECT 1;');
      await expect(migrateDatabase(adminUrl, password, url)).rejects.toThrow('present and unique');
      await rm(join(directory, '001_duplicate.sql'));
      await rm(join(directory, '002_placeholder.sql'));
      await writeFile(join(directory, '002_authenticated_memberships.sql'), await readFile(new URL('002_authenticated_memberships.sql', migrationsDirectory), 'utf8'));
      await writeFile(join(directory, '000_earlier.sql'), 'SELECT 1;');
      await expect(migrateDatabase(adminUrl, password, url)).rejects.toThrow('Out-of-order');
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it('connects as a nonowner without elevated attributes, memberships or schema administration', async () => {
    await expect(verifyRuntimeRole(pool)).resolves.toBeUndefined();
    await expect(verifyRuntimeRole(admin)).rejects.toThrow('Unsafe');
    const role = await pool.query(`SELECT current_user, rolsuper, rolbypassrls, rolcreatedb,
      rolcreaterole, rolinherit, rolreplication FROM pg_roles WHERE rolname = current_user`);
    expect(role.rows[0]).toEqual({ current_user: 'aegis_app', rolsuper: false, rolbypassrls: false,
      rolcreatedb: false, rolcreaterole: false, rolinherit: false, rolreplication: false });
    const tables = await pool.query(`SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity,
      pg_get_userbyid(c.relowner) = current_user AS owned
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'aegis' AND c.relkind = 'r' ORDER BY c.relname`);
    expect(tables.rows).toHaveLength(4);
    for (const table of tables.rows) expect(table).toMatchObject({ relrowsecurity: true, relforcerowsecurity: true, owned: false });
    expect((await pool.query(`SELECT count(*)::int AS count FROM pg_auth_members
      WHERE member = (SELECT oid FROM pg_roles WHERE rolname = current_user)`)).rows[0].count).toBe(0);
    const administrator = (await admin.query('SELECT current_user')).rows[0].current_user as string;
    for (const sql of [`SET ROLE "${administrator.replaceAll('"', '""')}"`,
      'ALTER TABLE aegis.support_cases DISABLE ROW LEVEL SECURITY',
      'ALTER TABLE aegis.support_cases DISABLE TRIGGER ALL',
      'CREATE TABLE aegis.unauthorized (id integer)',
      'CREATE TABLE public.unauthorized (id integer)',
      'TRUNCATE aegis.support_cases',
      'SELECT * FROM aegis_migrations.versions']) {
      await expect(pool.query(sql)).rejects.toMatchObject({ code: '42501' });
    }
  });

  it('persists synthetic cases across independent pools and retains deterministic triage', async () => {
    const updated = await a.update(northId, 'in_progress');
    expect(updated).toMatchObject({ id: northId, tenant_id: north.tenantId, status: 'in_progress' });
    const anotherPool = createDatabasePool(runtimeUrl, 1);
    try {
      expect(await new CaseRepository(anotherPool, north, log).read(northId)).toMatchObject({ status: 'in_progress' });
      expect(await a.triage(northId)).toMatchObject({ mode: 'synthetic-mock', caseId: 'SYNTHETIC-LOGIN-001' });
    } finally { await anotherPool.end(); }
    expect((await a.list()).every((row) => row.tenant_id === north.tenantId)).toBe(true);
  });

  it('records creation and status changes atomically, with append-only runtime access', async () => {
    const created = await a.create('SYNTHETIC-GUIDANCE-003');
    await a.update(created.id, 'resolved');
    expect(await a.audit(created.id)).toMatchObject([
      { tenant_id: north.tenantId, case_id: created.id, action: 'case.created', previous_status: null, new_status: 'open' },
      { tenant_id: north.tenantId, case_id: created.id, action: 'case.updated', previous_status: 'open', new_status: 'resolved' },
    ]);
    for (const sql of [
      'INSERT INTO aegis.audit_events (tenant_id, case_id, action, new_status) VALUES ($1, $2, \'case.created\', \'open\')',
      'UPDATE aegis.audit_events SET new_status = \'open\' WHERE tenant_id = $1 AND case_id = $2',
      'DELETE FROM aegis.audit_events WHERE tenant_id = $1 AND case_id = $2',
    ]) {
      await expect(withTenantTransaction(pool, north, (client) => client.query(sql, [north.tenantId, created.id])))
        .rejects.toMatchObject({ code: '42501' });
    }
  });
});

describe('default-deny tenant isolation in real SQL', () => {
  it('hides foreign cases and audits without revealing whether IDs exist', async () => {
    await expect(a.read(southId)).rejects.toMatchObject({ code: 'not_found' });
    await expect(a.update(southId, 'resolved')).rejects.toMatchObject({ code: 'not_found' });
    await expect(b.read(northId)).rejects.toMatchObject({ code: 'not_found' });
    expect(await a.audit(southId)).toEqual([]);
    await withTenantTransaction(pool, north, async (client) => {
      expect((await client.query('SELECT * FROM aegis.tenants')).rows).toEqual([{ id: north.tenantId, name: north.name }]);
      expect((await client.query('SELECT * FROM aegis.support_cases WHERE id = $1', [southId])).rows).toEqual([]);
      expect((await client.query('SELECT * FROM aegis.audit_events WHERE case_id = $1', [southId])).rows).toEqual([]);
      expect((await client.query('UPDATE aegis.support_cases SET status = \'resolved\' WHERE id = $1', [southId])).rowCount).toBe(0);
    });
  });

  it('rejects foreign tenant INSERT and tenant reassignment even with valid SQL', async () => {
    await expect(withTenantTransaction(pool, north, (client) => client.query(
      'INSERT INTO aegis.support_cases (tenant_id, synthetic_case_id) VALUES ($1, $2)',
      [south.tenantId, 'SYNTHETIC-LOGIN-001']))).rejects.toMatchObject({ code: '42501' });
    await expect(withTenantTransaction(pool, north, (client) => client.query(
      'UPDATE aegis.support_cases SET tenant_id = $1 WHERE id = $2', [south.tenantId, northId])))
      .rejects.toMatchObject({ code: '42501' });
    expect((await b.read(southId)).status).toBe('open');
  });

  it('denies all reads and writes without tenant context', async () => {
    for (const table of ['tenants', 'support_cases', 'audit_events']) {
      expect((await single.query(`SELECT * FROM aegis.${table}`)).rows).toEqual([]);
    }
    expect((await single.query('UPDATE aegis.support_cases SET status = \'resolved\'')).rowCount).toBe(0);
    await expect(single.query('INSERT INTO aegis.support_cases (tenant_id, synthetic_case_id) VALUES ($1, $2)',
      [north.tenantId, 'SYNTHETIC-LOGIN-001'])).rejects.toMatchObject({ code: '42501' });
    await expect(withTenantTransaction(single, north, async (client) => {
      await client.query("SELECT set_config('row_security', 'off', true)");
      await client.query('SELECT * FROM aegis.support_cases');
    })).rejects.toMatchObject({ code: '42501' });
    expect((await single.query('SELECT * FROM aegis.support_cases')).rows).toEqual([]);
  });

  it('rejects malformed values at application and database boundaries', async () => {
    for (const value of [null, {}, 'real customer', "' OR 1=1 --", '']) {
      await expect(a.create(value)).rejects.toMatchObject({ code: 'invalid_input' });
      await expect(a.read(value)).rejects.toMatchObject({ code: 'invalid_input' });
      await expect(a.update(northId, value)).rejects.toMatchObject({ code: 'invalid_input' });
    }
    await expect(withTenantTransaction(pool, north, (client) => client.query(
      'INSERT INTO aegis.support_cases (tenant_id, synthetic_case_id) VALUES ($1, $2)', [north.tenantId, 'arbitrary-input'])))
      .rejects.toMatchObject({ code: '23514' });
    await expect(withTenantTransaction(pool, north, (client) => client.query(
      'UPDATE aegis.support_cases SET status = $1 WHERE id = $2', ['invalid', northId])))
      .rejects.toMatchObject({ code: '23514' });
  });

  it('clears context after commit and rollback on the same pooled connection', async () => {
    for (const fixture of [north, south]) {
      await withTenantTransaction(single, fixture, async (client) => {
        expect((await client.query('SELECT id FROM aegis.tenants')).rows).toEqual([{ id: fixture.tenantId }]);
      });
      expect((await single.query('SELECT id FROM aegis.tenants')).rows).toEqual([]);
      await expect(withTenantTransaction(single, fixture, async () => { throw new Error('rollback requested'); }))
        .rejects.toThrow('rollback requested');
      expect((await single.query('SELECT id FROM aegis.tenants')).rows).toEqual([]);
    }
  });

  it('fails closed on malformed SQL tenant context and clears it after rollback', async () => {
    await expect(withTenantTransaction(single, north, async (client) => {
      await client.query("SELECT set_config('aegis.tenant_id', $1, true)", ['not-a-uuid']);
      await client.query('SELECT * FROM aegis.support_cases');
    })).rejects.toMatchObject({ code: '22P02' });
    expect((await single.query('SELECT * FROM aegis.tenants')).rows).toEqual([]);
    expect(await new CaseRepository(single, south, log).read(southId)).toMatchObject({ tenant_id: south.tenantId });
  });

  it('rolls back case creation, update and audit records together', async () => {
    let rolledBackId: string | undefined;
    const before = await a.audit(northId);
    const original = await a.read(northId);
    await expect(withTenantTransaction(pool, north, async (client) => {
      rolledBackId = (await client.query('INSERT INTO aegis.support_cases (tenant_id, synthetic_case_id) VALUES ($1, $2) RETURNING id',
        [north.tenantId, 'SYNTHETIC-LOGIN-001'])).rows[0].id;
      await client.query('UPDATE aegis.support_cases SET status = \'resolved\' WHERE id = $1', [northId]);
      throw new Error('rollback requested');
    })).rejects.toThrow('rollback requested');
    await expect(a.read(rolledBackId)).rejects.toMatchObject({ code: 'not_found' });
    expect(await a.audit(rolledBackId)).toEqual([]);
    expect(await a.audit(northId)).toEqual(before);
    expect((await a.read(northId)).status).toBe(original.status);
  });

  it('keeps concurrent transactions isolated across checked-out connections', async () => {
    await Promise.all(Array.from({ length: 12 }, (_, index) => {
      const fixture = index % 2 ? north : south;
      return withTenantTransaction(pool, fixture, async (client) => {
        await client.query('SELECT pg_sleep(0.01)');
        expect((await client.query('SELECT id FROM aegis.tenants')).rows).toEqual([{ id: fixture.tenantId }]);
        const result = await client.query('SELECT tenant_id FROM aegis.support_cases');
        expect(result.rows.every((row) => row.tenant_id === fixture.tenantId)).toBe(true);
      });
    }));
    expect((await pool.query('SELECT * FROM aegis.tenants')).rows).toEqual([]);
  });
});

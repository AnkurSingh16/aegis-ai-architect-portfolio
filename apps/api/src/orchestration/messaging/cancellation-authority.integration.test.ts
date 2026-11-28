import { randomUUID } from 'node:crypto';
import { copyFile, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { migrateDatabase, migrationsDirectory } from '../../storage/migrations.js';
import { checkCancellationAuthority, CancellationAuthorityError, verifyCancellationAuthority } from './cancellation-authority.js';

// Migration 025 on disposable databases (fresh install and 024-to-025 upgrade with a persisted pending cancellation), and the startup
// validation of privileged cancellation functions against negative configurations. Each mutation is reverted before the next check.

const adminUrl = process.env.TEST_DATABASE_ADMIN_URL;
if (!adminUrl) throw new Error('Set TEST_DATABASE_ADMIN_URL for real PostgreSQL tests.');
const appPassword = process.env.DATABASE_APP_PASSWORD ?? '';
const ingestPassword = process.env.DATABASE_INGEST_PASSWORD ?? '';
const admin = new Pool({ connectionString: adminUrl, max: 1 });
const created: string[] = [];
const roles: string[] = [];
const workDirs: string[] = [];
const pools: Pool[] = [];

function urlFor(database: string): string {
  const url = new URL(adminUrl!);
  url.pathname = `/${database}`;
  return url.toString();
}

async function freshDatabase(): Promise<{ name: string; url: string; pool: Pool }> {
  const name = `aegis_p8_mig25_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
  await admin.query(`CREATE DATABASE ${name}`);
  created.push(name);
  const url = urlFor(name);
  return { name, url, pool: new Pool({ connectionString: url, max: 2 }) };
}

/** A migrations directory that contains only the versions up to and including `lastVersion`. */
async function directoryUpTo(lastVersion: string): Promise<URL> {
  const dir = await mkdtemp(join(tmpdir(), 'aegis-mig25-'));
  workDirs.push(dir);
  for (const file of (await readdir(migrationsDirectory.pathname)).filter((f) => /^\d{3}_[a-z0-9_]+\.sql$/.test(f)).sort()) {
    if (file <= lastVersion) await copyFile(join(migrationsDirectory.pathname, file), join(dir, file));
  }
  return pathToFileURL(`${dir}/`);
}

afterAll(async () => {
  for (const p of pools) await p.end().catch(() => undefined);
  for (const name of created) await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`).catch(() => undefined);
  for (const role of roles) await admin.query(`DROP ROLE IF EXISTS ${role}`).catch(() => undefined);
  for (const dir of workDirs) await rm(dir, { recursive: true, force: true });
  await admin.end();
});

describe('migration 025 and cancellation authority validation on disposable databases', () => {
  it('fresh install reaches 025 and the privileged functions pass the catalog validation', async () => {
    const db = await freshDatabase();
    pools.push(db.pool);
    expect(await migrateDatabase(db.url, appPassword, ingestPassword)).toBe(25); // 001-025 on a fresh database
    const checks = await checkCancellationAuthority(db.pool, { identity: false });
    expect(checks.filter((c) => !c.ok).map((c) => c.name)).toEqual([]);
    expect(checks.map((c) => c.name)).toContain('orchestrator_due_cancellations:owner_reads_rows');
    await expect(verifyCancellationAuthority(db.pool, { identity: false })).resolves.toBeUndefined();
  }, 120000);

  it('upgrade from 024: a pending cancellation is scheduled for immediate eligibility and keeps a request time', async () => {
    const db = await freshDatabase();
    pools.push(db.pool);
    const before = await directoryUpTo('024_orchestrator_owned_cancellation.sql');
    expect(await migrateDatabase(db.url, appPassword, ingestPassword, before)).toBe(24); // 001-024 on a fresh database
    const tenant = '10000000-0000-4000-8000-000000000001';
    await db.pool.query(`INSERT INTO aegis.tenants (id, name) VALUES ($1, 'Synthetic North') ON CONFLICT (id) DO NOTHING`, [tenant]);
    const inserted = await db.pool.query<{ execution_id: string }>(
      `INSERT INTO aegis.agent_executions (tenant_id, idempotency_key, principal_ref, principal_scopes, root_agent, status, max_depth,
         max_delegations, max_steps, max_attempts, attempts, cancel_requested, cancel_reason, updated_at)
       VALUES ($1, 'upgrade-024-pending', repeat('a', 64), '{}', 'orchestrator', 'running', 4, 4, 50, 3, 1, true, 'user_request',
         clock_timestamp() - interval '1 hour') RETURNING execution_id`, [tenant]);
    const executionId = inserted.rows[0].execution_id;
    expect(await migrateDatabase(db.url, appPassword, ingestPassword)).toBe(1);
    const row = (await db.pool.query<{ cancel_requested_at: Date | null; next: Date | null; attempts: number }>(
      `SELECT cancel_requested_at, cancellation_next_attempt_at AS next, cancellation_attempts AS attempts
         FROM aegis.agent_executions WHERE execution_id = $1`, [executionId])).rows[0];
    expect(row.cancel_requested_at).not.toBeNull();
    expect(row.next).not.toBeNull();
    expect(row.next!.getTime()).toBeLessThanOrEqual(Date.now());
    expect(row.attempts).toBe(0);
    const versions = await db.pool.query<{ version: string }>('SELECT version FROM aegis_migrations.versions ORDER BY version DESC LIMIT 1');
    expect(versions.rows[0].version).toBe('025_cancellation_retry_and_fairness.sql');
  }, 120000);

  it('the validation refuses each negative configuration, names the failed check, and passes again once reverted', async () => {
    const db = await freshDatabase();
    pools.push(db.pool);
    await migrateDatabase(db.url, appPassword, ingestPassword);
    const owner = (await db.pool.query<{ owner: string }>(
      `SELECT pg_get_userbyid(p.proowner) AS owner FROM pg_proc p WHERE p.oid = 'aegis.orchestrator_due_cancellations(integer)'::regprocedure`)).rows[0].owner;
    const failed = async () => (await checkCancellationAuthority(db.pool, { identity: false })).filter((c) => !c.ok).map((c) => c.name);

    await db.pool.query('GRANT EXECUTE ON FUNCTION aegis.orchestrator_due_cancellations(integer) TO PUBLIC');
    expect(await failed()).toContain('orchestrator_due_cancellations:no_public_execute');
    await db.pool.query('REVOKE EXECUTE ON FUNCTION aegis.orchestrator_due_cancellations(integer) FROM PUBLIC');

    await db.pool.query('GRANT EXECUTE ON FUNCTION aegis.orchestrator_due_cancellations(integer) TO aegis_triage');
    expect(await failed()).toContain('orchestrator_due_cancellations:no_unexpected_execute');
    await db.pool.query('REVOKE EXECUTE ON FUNCTION aegis.orchestrator_due_cancellations(integer) FROM aegis_triage');

    await db.pool.query('ALTER FUNCTION aegis.orchestrator_cancellation_backlog() RESET search_path');
    expect(await failed()).toContain('orchestrator_cancellation_backlog:search_path_pinned');
    await db.pool.query('ALTER FUNCTION aegis.orchestrator_cancellation_backlog() SET search_path = pg_catalog, aegis');

    const plainOwner = `aegis_p8_plain_owner_${randomUUID().replace(/-/g, '').slice(0, 10)}`;
    roles.push(plainOwner);
    await admin.query(`CREATE ROLE ${plainOwner} NOLOGIN NOBYPASSRLS`);
    await db.pool.query(`ALTER FUNCTION aegis.orchestrator_due_cancellations(integer) OWNER TO ${plainOwner}`);
    expect(await failed()).toContain('orchestrator_due_cancellations:owner_reads_rows');
    await db.pool.query(`ALTER FUNCTION aegis.orchestrator_due_cancellations(integer) OWNER TO "${owner}"`);

    expect(await failed()).toEqual([]);
    await expect(verifyCancellationAuthority(db.pool, { identity: false })).resolves.toBeUndefined();

    // The superuser test identity must not pass the runtime identity check: a superuser could reach any table.
    await expect(verifyCancellationAuthority(db.pool, { identity: true })).rejects.toBeInstanceOf(CancellationAuthorityError);
  }, 120000);

  it('a missing privileged function fails validation with a clear check name', async () => {
    const db = await freshDatabase();
    pools.push(db.pool);
    await migrateDatabase(db.url, appPassword, ingestPassword);
    await db.pool.query('DROP FUNCTION aegis.orchestrator_cancellation_backlog()');
    const error = await verifyCancellationAuthority(db.pool, { identity: false }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CancellationAuthorityError);
    expect((error as CancellationAuthorityError).failed).toContain('orchestrator_cancellation_backlog:present');
  }, 120000);
});

describe('startup authority: effective privileges, trigger attachment, role membership', () => {
  it('a BYPASSRLS owner without the table privilege fails: BYPASSRLS is not proof of effective access', async () => {
    const db = await freshDatabase();
    pools.push(db.pool);
    await migrateDatabase(db.url, appPassword, ingestPassword);
    const plainBypass = `aegis_p8_bypass_only_${randomUUID().replace(/-/g, '').slice(0, 10)}`;
    roles.push(plainBypass);
    await admin.query(`CREATE ROLE ${plainBypass} NOLOGIN BYPASSRLS`);
    const original = (await db.pool.query<{ owner: string }>(
      `SELECT pg_get_userbyid(p.proowner) AS owner FROM pg_proc p WHERE p.oid = 'aegis.orchestrator_due_cancellations(integer)'::regprocedure`)).rows[0].owner;
    await db.pool.query(`ALTER FUNCTION aegis.orchestrator_due_cancellations(integer) OWNER TO ${plainBypass}`);
    const failed = (await checkCancellationAuthority(db.pool, { identity: false })).filter((c) => !c.ok).map((c) => c.name);
    expect(failed).toContain('orchestrator_due_cancellations:owner_selects_executions');
    expect(failed).not.toContain('orchestrator_due_cancellations:owner_reads_rows');
    await db.pool.query(`ALTER FUNCTION aegis.orchestrator_due_cancellations(integer) OWNER TO "${original}"`);
  }, 120000);

  it('a dropped cancellation enforcement trigger fails validation by name', async () => {
    const db = await freshDatabase();
    pools.push(db.pool);
    await migrateDatabase(db.url, appPassword, ingestPassword);
    await db.pool.query('DROP TRIGGER agent_grant_refuse_consume_after_cancel ON aegis.agent_grants');
    const failed = (await checkCancellationAuthority(db.pool, { identity: false })).filter((c) => !c.ok).map((c) => c.name);
    expect(failed).toContain('trigger:agent_grant_refuse_consume_after_cancel:present');
  }, 120000);

  it('a disabled cancellation trigger fails validation: it is attached but not enabled', async () => {
    const db = await freshDatabase();
    pools.push(db.pool);
    await migrateDatabase(db.url, appPassword, ingestPassword);
    await db.pool.query('ALTER TABLE aegis.agent_executions DISABLE TRIGGER agent_execution_record_cancellation_request');
    const failed = (await checkCancellationAuthority(db.pool, { identity: false })).filter((c) => !c.ok).map((c) => c.name);
    expect(failed).toContain('trigger:agent_execution_record_cancellation_request:enabled');
    expect(failed).not.toContain('trigger:agent_execution_record_cancellation_request:attached');
  }, 120000);

  it('a missing required signature fails validation even when a function of the same name exists with another signature', async () => {
    const db = await freshDatabase();
    pools.push(db.pool);
    await migrateDatabase(db.url, appPassword, ingestPassword);
    await db.pool.query('DROP FUNCTION aegis.orchestrator_due_cancellations(integer)');
    await db.pool.query(`CREATE FUNCTION aegis.orchestrator_due_cancellations(p text) RETURNS integer LANGUAGE sql AS 'SELECT 1'`);
    const failed = (await checkCancellationAuthority(db.pool, { identity: false })).filter((c) => !c.ok).map((c) => c.name);
    expect(failed).toContain('orchestrator_due_cancellations:present');
  }, 120000);

  it('a role membership on the runtime identity fails validation, so role assumption is not possible through inheritance', async () => {
    const db = await freshDatabase();
    pools.push(db.pool);
    await migrateDatabase(db.url, appPassword, ingestPassword);
    const who = (await db.pool.query<{ u: string }>('SELECT session_user AS u')).rows[0].u;
    await db.pool.query(`GRANT aegis_triage TO "${who}"`);
    try {
      const failed = (await checkCancellationAuthority(db.pool, { identity: true })).filter((c) => !c.ok).map((c) => c.name);
      expect(failed).toContain('runtime_identity:no_role_membership');
    } finally {
      await db.pool.query(`REVOKE aegis_triage FROM "${who}"`);
    }
  }, 120000);
});

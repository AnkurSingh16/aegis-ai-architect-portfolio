import { randomUUID } from 'node:crypto';
import { copyFile, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { migrateDatabase, migrationsDirectory } from '../../storage/migrations.js';

// Migration 016 against disposable databases: a fresh database, a database previously migrated to 015, a second run (idempotence),
// and a tampered applied migration (checksum integrity). Each database is created for this test and dropped afterwards.
const adminUrl = process.env.TEST_DATABASE_ADMIN_URL;
if (!adminUrl) throw new Error('Set TEST_DATABASE_ADMIN_URL for real PostgreSQL tests.');
const appPassword = process.env.DATABASE_APP_PASSWORD ?? '';
const ingestPassword = process.env.DATABASE_INGEST_PASSWORD ?? '';

const admin = new Pool({ connectionString: adminUrl, max: 1 });
const created: string[] = [];
const workDirs: string[] = [];

function urlFor(database: string): string {
  const url = new URL(adminUrl!);
  url.pathname = `/${database}`;
  return url.toString();
}

async function freshDatabase(): Promise<{ name: string; url: string }> {
  const name = `aegis_p4_mig_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
  await admin.query(`CREATE DATABASE ${name}`);
  created.push(name);
  return { name, url: urlFor(name) };
}

/** A migrations directory that contains only the versions up to and including `lastVersion`. */
async function directoryUpTo(lastVersion: string): Promise<URL> {
  const dir = await mkdtemp(join(tmpdir(), 'aegis-mig-'));
  workDirs.push(dir);
  const sourceDir = migrationsDirectory.pathname;
  for (const file of (await readdir(sourceDir)).filter((f) => /^\d{3}_[a-z0-9_]+\.sql$/.test(f)).sort()) {
    if (file <= lastVersion) await copyFile(join(sourceDir, file), join(dir, file));
  }
  return pathToFileURL(`${dir}/`);
}

const rlsForced = async (url: string) => {
  const pool = new Pool({ connectionString: url, max: 1 });
  try {
    const result = await pool.query<{ relname: string; forced: boolean }>(
      `SELECT relname, relrowsecurity AND relforcerowsecurity AS forced FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'aegis' AND relname LIKE 'agent\\_%' AND relkind = 'r' ORDER BY relname`);
    return result.rows;
  } finally {
    await pool.end();
  }
};

afterAll(async () => {
  for (const name of created) {
    await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`).catch(() => undefined);
  }
  for (const dir of workDirs) await rm(dir, { recursive: true, force: true });
  await admin.end();
});

describe('migration 016 on disposable databases', () => {
  it('a fresh database migrates to the current version, and the agent tables are forced under RLS', async () => {
    const db = await freshDatabase();
    expect(await migrateDatabase(db.url, appPassword, ingestPassword)).toBeGreaterThan(15);
    const rows = await rlsForced(db.url);
    expect(rows.map((r) => r.relname)).toEqual(['agent_delegations', 'agent_execution_events', 'agent_executions', 'agent_grants',
      'agent_inbox', 'agent_message_events', 'agent_outbox', 'agent_outbox_actions', 'agent_registrations']);
    expect(rows.every((r) => r.forced)).toBe(true);
    const pool = new Pool({ connectionString: db.url, max: 1 });
    const seeded = await pool.query<{ n: string }>('SELECT count(*)::text AS n FROM aegis.agent_registrations');
    await pool.end();
    expect(seeded.rows[0].n).toBe('4');
  });

  it('a database previously migrated to 015 upgrades additively through 016 and 017, and a second run applies nothing', async () => {
    const db = await freshDatabase();
    const before = await directoryUpTo('015_readiness_access.sql');
    expect(await migrateDatabase(db.url, appPassword, ingestPassword, before)).toBe(15);
    const pool = new Pool({ connectionString: db.url, max: 1 });
    const beforeTables = await pool.query<{ n: string }>("SELECT count(*)::text AS n FROM pg_tables WHERE schemaname = 'aegis' AND tablename LIKE 'agent\\_%'");
    expect(beforeTables.rows[0].n).toBe('0');
    expect(await migrateDatabase(db.url, appPassword, ingestPassword)).toBe(2);
    expect(await migrateDatabase(db.url, appPassword, ingestPassword)).toBe(0);
    const versions = await pool.query<{ version: string }>('SELECT version FROM aegis_migrations.versions ORDER BY version');
    expect(versions.rows.at(-2)?.version).toBe('016_agent_execution_state.sql');
    expect(versions.rows.at(-1)?.version).toBe('017_transactional_messaging.sql');
    await pool.end();
  });

  it('an applied migration that has been changed is refused, so the recorded checksum stays authoritative', async () => {
    const db = await freshDatabase();
    const dir = await directoryUpTo('016_agent_execution_state.sql');
    expect(await migrateDatabase(db.url, appPassword, ingestPassword, dir)).toBeGreaterThan(15);
    const tampered = await directoryUpTo('016_agent_execution_state.sql');
    await writeFile(new URL('015_readiness_access.sql', tampered), '-- changed after it was applied\n');
    await expect(migrateDatabase(db.url, appPassword, ingestPassword, tampered)).rejects.toThrow(/was modified/);
  });
});

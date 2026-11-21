import { mkdtemp, writeFile, copyFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { checkReadiness } from './readiness.js';
import { createDatabasePool } from './storage/database.js';
import { migrateDatabase, migrationsDirectory } from './storage/migrations.js';

// Readiness against real PostgreSQL: the runtime role must be able to read the migration record, and a missing migration must be
// reported as pending rather than ready.
const adminUrl = process.env.TEST_DATABASE_ADMIN_URL;
const runtimeUrl = process.env.TEST_DATABASE_URL;
const appPassword = process.env.DATABASE_APP_PASSWORD;
const ingestPassword = process.env.DATABASE_INGEST_PASSWORD;
if (!adminUrl || !runtimeUrl || !appPassword || !ingestPassword) {
  throw new Error('Set TEST_DATABASE_ADMIN_URL, TEST_DATABASE_URL, DATABASE_APP_PASSWORD and DATABASE_INGEST_PASSWORD.');
}

let pool: Pool;
let scratch: string;

beforeAll(async () => {
  await migrateDatabase(adminUrl, appPassword, ingestPassword);
  pool = createDatabasePool(runtimeUrl);
  scratch = await mkdtemp(join(tmpdir(), 'aegis-readiness-'));
});

afterAll(async () => {
  await pool?.end();
  await rm(scratch, { recursive: true, force: true });
});

describe('GET /api/ready dependency check (real PostgreSQL)', () => {
  it('reports ready with every migration applied, using the runtime role', async () => {
    const expected = (await readdir(migrationsDirectory)).filter((file) => /^\d{3}_[a-z0-9_]+\.sql$/.test(file)).length;
    const result = await checkReadiness(pool);
    expect(result).toEqual({ ready: true, database: 'ok', migrations: { applied: expected, expected } });
  });

  it('reports migrations pending when a migration file has not been applied', async () => {
    const directory = join(scratch, 'migrations');
    await checkpointDirectory(directory);
    await writeFile(join(directory, '999_not_yet_applied.sql'), '-- test fixture, never applied\n');
    const result = await checkReadiness(pool, pathToFileURL(`${directory}/`));
    expect(result).toEqual({ ready: false, reason: 'migrations_pending' });
  });

  it('reports database unavailable without exposing connection details', async () => {
    const unreachable = new Pool({ connectionString: 'postgres://aegis_app:not-the-password@127.0.0.1:1/aegis_local', connectionTimeoutMillis: 500 });
    try {
      const result = await checkReadiness(unreachable);
      expect(result).toEqual({ ready: false, reason: 'database_unavailable' });
      expect(JSON.stringify(result)).not.toContain('not-the-password');
    } finally {
      await unreachable.end();
    }
  });
});

async function checkpointDirectory(directory: string): Promise<void> {
  const { mkdir } = await import('node:fs/promises');
  await mkdir(directory, { recursive: true });
  for (const file of (await readdir(migrationsDirectory)).filter((name) => name.endsWith('.sql'))) {
    await copyFile(new URL(file, migrationsDirectory), join(directory, file));
  }
}

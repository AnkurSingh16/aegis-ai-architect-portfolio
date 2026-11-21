import { readdir } from 'node:fs/promises';
import type { Pool } from 'pg';
import { migrationsDirectory } from './storage/migrations.js';

/**
 * Readiness is different from liveness. `GET /api/health` answers whether the process is running and does not touch dependencies.
 * `GET /api/ready` answers whether this instance can serve database-backed requests: the runtime role can reach PostgreSQL, and every
 * migration file in `db/migrations` is recorded as applied. It returns counts and reason codes only, never connection details.
 */
export type ReadinessResult =
  | { readonly ready: true; readonly database: 'ok'; readonly migrations: { readonly applied: number; readonly expected: number } }
  | { readonly ready: false; readonly reason: 'database_unavailable' | 'migrations_pending' };

const MIGRATION_FILE = /^\d{3}_[a-z0-9_]+\.sql$/;

export async function checkReadiness(pool: Pool, directory: URL = migrationsDirectory): Promise<ReadinessResult> {
  const expected = (await readdir(directory)).filter((file) => MIGRATION_FILE.test(file));
  let appliedVersions: Set<string>;
  try {
    const rows = await pool.query<{ version: string }>('SELECT applied_versions AS version FROM aegis_migrations.applied_versions()');
    appliedVersions = new Set(rows.rows.map((row) => row.version));
  } catch {
    return { ready: false, reason: 'database_unavailable' };
  }
  const applied = expected.filter((file) => appliedVersions.has(file)).length;
  if (applied !== expected.length) return { ready: false, reason: 'migrations_pending' };
  return { ready: true, database: 'ok', migrations: { applied, expected: expected.length } };
}

import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { localDatabaseUrl } from './config.js';

export const migrationsDirectory = new URL('../../db/migrations/', import.meta.url);

/** Administrative command only. Never pass this pool to application operations. */
export async function migrateDatabase(adminUrl: string, applicationPassword: string,
  directory: URL = migrationsDirectory): Promise<number> {
  localDatabaseUrl(adminUrl);
  if (applicationPassword.length < 16 || applicationPassword.length > 256) {
    throw new Error('Application password must contain 16–256 characters.');
  }
  const pool = new Pool({ connectionString: adminUrl, max: 1, connectionTimeoutMillis: 5000 });
  try {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(73451002)');
      const role = await client.query<{ safe: boolean }>(`SELECT NOT rolsuper AND NOT rolbypassrls
        AND NOT rolcreaterole AND NOT rolcreatedb AND NOT rolinherit AND NOT rolreplication
        AND NOT EXISTS (SELECT 1 FROM pg_auth_members WHERE member = pg_roles.oid) AS safe
        FROM pg_roles WHERE rolname = 'aegis_app'`);
      if (role.rows[0] && role.rows[0].safe !== true) throw new Error('Existing application role has unsafe privileges.');
      if (!role.rows[0]) {
        // Password travels as a parameter, never interpolated into client-side SQL or logs.
        await client.query("SELECT set_config('aegis.bootstrap_password', $1, true)", [applicationPassword]);
        await client.query(`DO $$ BEGIN EXECUTE format(
          'CREATE ROLE aegis_app LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION PASSWORD %L',
          current_setting('aegis.bootstrap_password')); END $$`);
      }
      await client.query('REVOKE CREATE ON SCHEMA public FROM PUBLIC');
      await client.query('CREATE SCHEMA IF NOT EXISTS aegis_migrations');
      await client.query('REVOKE ALL ON SCHEMA aegis_migrations FROM PUBLIC');
      await client.query(`CREATE TABLE IF NOT EXISTS aegis_migrations.versions (
        version text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`);
      const applied = await client.query<{ version: string; checksum: string }>('SELECT version, checksum FROM aegis_migrations.versions');
      const files = (await readdir(directory)).filter((file) => /^\d{3}_[a-z0-9_]+\.sql$/.test(file)).sort();
      if (files.length === 0 || new Set(files.map((file) => file.slice(0, 3))).size !== files.length) {
        throw new Error('Migration versions must be present and unique.');
      }
      if (applied.rows.some((entry) => !files.includes(entry.version))) throw new Error('An applied migration is missing.');
      let count = 0;
      for (const file of files) {
        const sql = await readFile(new URL(file, directory), 'utf8');
        const checksum = createHash('sha256').update(sql).digest('hex');
        const existing = applied.rows.find((entry) => entry.version === file);
        if (existing && existing.checksum !== checksum) throw new Error('An applied migration was modified.');
        if (!existing) {
          if (applied.rows.some((entry) => entry.version > file)) throw new Error('Out-of-order migration refused.');
          await client.query(sql);
          await client.query('INSERT INTO aegis_migrations.versions (version, checksum) VALUES ($1, $2)', [file, checksum]);
          count++;
        }
      }
      await client.query('COMMIT');
      return count;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
  } finally {
    await pool.end();
  }
}

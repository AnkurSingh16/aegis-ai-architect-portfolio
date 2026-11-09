import { Pool, type PoolClient } from 'pg';
import { localDatabaseUrl, type DevelopmentFixture } from './config.js';

export function createDatabasePool(url: string, max = 4): Pool {
  const pool = new Pool({ connectionString: localDatabaseUrl(url), max, connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 10000, statement_timeout: 5000, application_name: 'aegis-local-cases' });
  // Idle connection errors must not crash the process or print connection details.
  pool.on('error', () => console.error(JSON.stringify({ event: 'database.connection_error' })));
  return pool;
}

/** Fail closed if credentials accidentally point at an administrator or table owner. */
export async function verifyRuntimeRole(pool: Pool): Promise<void> {
  const result = await pool.query<{ safe: boolean }>(`
    WITH expected_tables(name) AS (VALUES
      ('tenants'), ('support_cases'), ('audit_events'), ('memberships'), ('documents'), ('document_chunks')),
    aegis_tables AS (
      SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity, c.relowner
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'aegis' AND c.relkind IN ('r', 'p', 'f')
    )
    SELECT current_user = 'aegis_app' AND session_user = 'aegis_app'
      AND NOT r.rolsuper AND NOT r.rolbypassrls AND NOT r.rolcreaterole
      AND NOT r.rolcreatedb AND NOT r.rolinherit AND NOT r.rolreplication
      AND NOT EXISTS (SELECT 1 FROM pg_auth_members WHERE member = r.oid)
      AND NOT has_schema_privilege(current_user, 'aegis', 'CREATE')
      AND NOT has_schema_privilege(current_user, 'public', 'CREATE')
      AND NOT has_database_privilege(current_user, current_database(), 'CREATE')
      AND NOT has_table_privilege(current_user, 'aegis.memberships', 'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
      AND NOT has_any_column_privilege(current_user, 'aegis.memberships', 'INSERT,UPDATE,REFERENCES')
      AND (SELECT count(*) = 6 AND bool_and(t.relrowsecurity AND t.relforcerowsecurity AND t.relowner <> r.oid)
        FROM aegis_tables t JOIN expected_tables e ON e.name = t.relname)
      AND NOT EXISTS (SELECT 1 FROM expected_tables e WHERE NOT EXISTS
        (SELECT 1 FROM aegis_tables t WHERE t.relname = e.name))
      AND NOT EXISTS (SELECT 1 FROM aegis_tables t WHERE NOT EXISTS
        (SELECT 1 FROM expected_tables e WHERE e.name = t.relname))
      AND has_table_privilege(current_user, 'aegis.tenants', 'SELECT')
      AND has_table_privilege(current_user, 'aegis.support_cases', 'SELECT')
      AND has_table_privilege(current_user, 'aegis.audit_events', 'SELECT')
      AND has_table_privilege(current_user, 'aegis.memberships', 'SELECT')
      AND has_table_privilege(current_user, 'aegis.documents', 'SELECT')
      AND has_table_privilege(current_user, 'aegis.document_chunks', 'SELECT')
      AND NOT has_table_privilege(current_user, 'aegis.tenants', 'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
      AND NOT has_table_privilege(current_user, 'aegis.audit_events', 'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
      AND NOT has_table_privilege(current_user, 'aegis.memberships', 'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
      AND NOT has_any_column_privilege(current_user, 'aegis.tenants', 'INSERT,UPDATE,REFERENCES')
      AND NOT has_any_column_privilege(current_user, 'aegis.audit_events', 'INSERT,UPDATE,REFERENCES')
      AND NOT has_table_privilege(current_user, 'aegis.support_cases', 'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
      AND has_column_privilege(current_user, 'aegis.support_cases', 'tenant_id', 'INSERT')
      AND has_column_privilege(current_user, 'aegis.support_cases', 'synthetic_case_id', 'INSERT')
      AND has_column_privilege(current_user, 'aegis.support_cases', 'status', 'UPDATE')
      AND NOT EXISTS (SELECT 1 FROM pg_attribute a
        WHERE a.attrelid = 'aegis.support_cases'::regclass AND a.attnum > 0 AND NOT a.attisdropped
          AND ((has_column_privilege(current_user, a.attrelid, a.attnum, 'INSERT')
              AND a.attname NOT IN ('tenant_id', 'synthetic_case_id'))
            OR (has_column_privilege(current_user, a.attrelid, a.attnum, 'UPDATE') AND a.attname <> 'status')
            OR has_column_privilege(current_user, a.attrelid, a.attnum, 'REFERENCES')))
      AND NOT has_table_privilege(current_user, 'aegis.documents', 'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
      AND NOT has_table_privilege(current_user, 'aegis.document_chunks', 'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
      AND NOT has_any_column_privilege(current_user, 'aegis.documents', 'INSERT,UPDATE,REFERENCES')
      AND NOT has_any_column_privilege(current_user, 'aegis.document_chunks', 'INSERT,UPDATE,REFERENCES') AS safe
    FROM pg_roles r WHERE r.rolname = current_user`);
  if (result.rows[0]?.safe !== true) throw new Error('Unsafe application database role or schema.');
}

/** One connection, one transaction, context automatically expires on commit/rollback. */
export async function withTenantTransaction<T>(pool: Pool, fixture: DevelopmentFixture,
  operation: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  let broken = false;
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('aegis.access_mode', 'fixture', true), set_config('aegis.principal_issuer', '', true), set_config('aegis.principal_subject', '', true)");
    await client.query("SELECT set_config('aegis.tenant_id', $1, true)", [fixture.tenantId]);
    const result = await operation(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { broken = true; }
    throw error;
  } finally { client.release(broken); }
}

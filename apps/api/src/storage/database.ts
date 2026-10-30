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
    SELECT current_user = 'aegis_app' AND session_user = 'aegis_app'
      AND NOT r.rolsuper AND NOT r.rolbypassrls AND NOT r.rolcreaterole
      AND NOT r.rolcreatedb AND NOT r.rolinherit AND NOT r.rolreplication
      AND NOT EXISTS (SELECT 1 FROM pg_auth_members WHERE member = r.oid)
      AND NOT has_schema_privilege(current_user, 'aegis', 'CREATE')
      AND NOT has_schema_privilege(current_user, 'public', 'CREATE')
      AND NOT has_database_privilege(current_user, current_database(), 'CREATE')
      AND NOT has_table_privilege(current_user, 'aegis.memberships', 'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
      AND NOT has_any_column_privilege(current_user, 'aegis.memberships', 'INSERT,UPDATE,REFERENCES')
      AND (SELECT count(*) = 4 AND bool_and(c.relrowsecurity AND c.relforcerowsecurity AND c.relowner <> r.oid)
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'aegis' AND c.relname IN ('tenants', 'support_cases', 'audit_events', 'memberships')) AS safe
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

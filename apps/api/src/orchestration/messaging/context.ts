import type { Pool, PoolClient } from 'pg';
import type { TenantQueryable } from '../../security/tool-approval-store.js';

/**
 * Runs one transaction with the tenant setting the policies read. The tenant is taken from verified execution context, never from
 * message content alone. The agent identity is the login role of the connection.
 */
export async function withMessagingContext<T>(pool: Pool, scope: { tenantId?: string },
  operation: (client: TenantQueryable) => Promise<T>): Promise<T> {
  const client: PoolClient = await pool.connect();
  try {
    await client.query('BEGIN');
    // Only the tenant is a session setting. The agent identity is the database login role (migration 018), not a setting.
    await client.query("SELECT set_config('aegis.tenant_id', $1, true)", [scope.tenantId ?? '']);
    const result = await operation(client as unknown as TenantQueryable);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Fails closed unless this pool's database login is the role mapped to `agentId` (migration 018), and the login is not privileged. The
 * check uses the server's mapping, not any value the process supplies.
 */
export async function verifyAgentRole(pool: Pool, agentId: string): Promise<void> {
  const result = await pool.query<{ agent: string | null; privileged: boolean }>(
    `SELECT aegis.current_agent() AS agent,
            (SELECT rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb FROM pg_roles WHERE rolname = current_user) AS privileged`);
  const row = result.rows[0];
  if (!row || row.agent !== agentId || row.privileged) throw new Error('database role does not match the agent identity');
}

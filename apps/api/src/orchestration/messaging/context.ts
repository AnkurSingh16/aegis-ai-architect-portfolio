import type { Pool, PoolClient } from 'pg';
import type { TenantQueryable } from '../../security/tool-approval-store.js';

/**
 * Runs one transaction with the settings the policies in migration 017 read. Tenant scope comes from the caller's verified tenant.
 * Dispatch scope comes from the process's verified agent identity. Neither is ever taken from message content.
 */
export async function withMessagingContext<T>(pool: Pool, scope: { tenantId?: string; agentId?: string },
  operation: (client: TenantQueryable) => Promise<T>): Promise<T> {
  const client: PoolClient = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('aegis.tenant_id', $1, true), set_config('aegis.agent_id', $2, true)",
      [scope.tenantId ?? '', scope.agentId ?? '']);
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

import type { Pool, PoolClient } from 'pg';
import { validateCaseId } from '../storage/models.js';
import { AuthorizationError, requireScope, type Permission, type VerifiedPrincipal } from './token.js';

/** Authorization and case queries share one membership snapshot and checked-out connection. */
export async function withAuthenticatedTransaction<T>(pool: Pool, principal: VerifiedPrincipal,
  requestedTenant: string, permission: Permission, operation: (client: PoolClient) => Promise<T>): Promise<T> {
  requireScope(principal, permission);
  const tenantId = validateCaseId(requestedTenant);
  const client = await pool.connect();
  let broken = false;
  try {
    // SELECT-only memberships cannot use FOR SHARE. A consistent snapshot preserves
    // authorization for this request without granting runtime membership mutation.
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
    await client.query(`SELECT set_config('aegis.access_mode', 'authenticated', true),
      set_config('aegis.principal_issuer', $1, true), set_config('aegis.principal_subject', $2, true),
      set_config('aegis.tenant_id', '', true)`, [principal.issuer, principal.subject]);
    const result = await client.query<{ role: string }>(`SELECT role FROM aegis.memberships
      WHERE issuer = $1 AND subject = $2 AND tenant_id = $3`, [principal.issuer, principal.subject, tenantId]);
    const role = result.rows[0]?.role;
    if ((role !== 'reader' && role !== 'operator') || (permission === 'write:cases' && role !== 'operator')) {
      throw new AuthorizationError(403);
    }
    await client.query("SELECT set_config('aegis.tenant_id', $1, true)", [tenantId]);
    const value = await operation(client);
    await client.query('COMMIT');
    return value;
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { broken = true; }
    throw error;
  } finally { client.release(broken); }
}

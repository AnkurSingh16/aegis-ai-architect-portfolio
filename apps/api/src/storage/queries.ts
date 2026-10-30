import type { PoolClient } from 'pg';
import { CaseStorageError, validateCaseId, validateStatus, validateSyntheticCase, type StoredCase } from './models.js';

/** Shared queries use the caller's checked-out transaction; they never check out a pool connection. */
export async function createCase(client: PoolClient, tenantId: string, syntheticCase: unknown): Promise<StoredCase> {
  const result = await client.query<StoredCase>(`INSERT INTO aegis.support_cases (tenant_id, synthetic_case_id)
    VALUES ($1, $2) RETURNING *`, [tenantId, validateSyntheticCase(syntheticCase)]);
  return result.rows[0];
}
export async function listCases(client: PoolClient): Promise<StoredCase[]> {
  return (await client.query<StoredCase>('SELECT * FROM aegis.support_cases ORDER BY created_at, id LIMIT 100')).rows;
}
export async function readCase(client: PoolClient, id: unknown): Promise<StoredCase> {
  const result = await client.query<StoredCase>('SELECT * FROM aegis.support_cases WHERE id = $1', [validateCaseId(id)]);
  if (!result.rows[0]) throw new CaseStorageError('not_found');
  return result.rows[0];
}
export async function updateCase(client: PoolClient, id: unknown, status: unknown): Promise<StoredCase> {
  const result = await client.query<StoredCase>('UPDATE aegis.support_cases SET status = $1 WHERE id = $2 RETURNING *',
    [validateStatus(status), validateCaseId(id)]);
  if (!result.rows[0]) throw new CaseStorageError('not_found');
  return result.rows[0];
}

import type { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { syntheticCases, type SyntheticCaseId } from '../contracts/triage.js';
import { triageCase } from '../triage.js';
import type { DevelopmentFixture } from './config.js';
import { withTenantTransaction } from './database.js';

export const caseStatuses = ['open', 'in_progress', 'resolved'] as const;
export type CaseStatus = typeof caseStatuses[number];
export interface StoredCase {
  id: string; tenant_id: string; synthetic_case_id: SyntheticCaseId; status: CaseStatus;
  created_at: Date; updated_at: Date;
}
export interface AuditEvent {
  id: string; tenant_id: string; case_id: string; action: 'case.created' | 'case.updated';
  previous_status: CaseStatus | null; new_status: CaseStatus; occurred_at: Date;
}
export class CaseStorageError extends Error {
  constructor(public readonly code: 'invalid_input' | 'not_found' | 'unavailable') {
    super(code === 'invalid_input' ? 'Invalid case command.'
      : code === 'not_found' ? 'Case not found.' : 'Case storage is unavailable. Retry after checking the local database.');
  }
}
export function validateCaseId(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new CaseStorageError('invalid_input');
  }
  return value;
}
export function validateSyntheticCase(value: unknown): SyntheticCaseId {
  const fixture = syntheticCases.find((item) => item.id === value);
  if (!fixture) throw new CaseStorageError('invalid_input');
  return fixture.id;
}
export function validateStatus(value: unknown): CaseStatus {
  if (!caseStatuses.some((status) => status === value)) throw new CaseStorageError('invalid_input');
  return value as CaseStatus;
}
export type StorageLog = (event: { event: 'case_storage'; operation: string; outcome: 'success' | 'failure';
  operationId: string; code?: string }) => void;

export class CaseRepository {
  constructor(private readonly pool: Pool, private readonly fixture: DevelopmentFixture,
    private readonly log: StorageLog = (event) => console.error(JSON.stringify(event))) {}

  private async run<T>(operation: string, execute: Parameters<typeof withTenantTransaction<T>>[2]): Promise<T> {
    const operationId = randomUUID();
    try {
      const result = await withTenantTransaction(this.pool, this.fixture, execute);
      this.log({ event: 'case_storage', operation, operationId, outcome: 'success' });
      return result;
    } catch (error) {
      const safe = error instanceof CaseStorageError ? error : new CaseStorageError('unavailable');
      this.log({ event: 'case_storage', operation, operationId, outcome: 'failure', code: safe.code });
      throw safe;
    }
  }

  async create(syntheticCase: unknown): Promise<StoredCase> {
    const caseId = validateSyntheticCase(syntheticCase);
    return this.run('create', async (client) => {
      const result = await client.query<StoredCase>(`INSERT INTO aegis.support_cases (tenant_id, synthetic_case_id)
        VALUES ($1, $2) RETURNING *`, [this.fixture.tenantId, caseId]);
      return result.rows[0];
    });
  }
  async list(): Promise<StoredCase[]> {
    return this.run('list', async (client) => (await client.query<StoredCase>(
      'SELECT * FROM aegis.support_cases ORDER BY created_at, id LIMIT 100')).rows);
  }
  async read(id: unknown): Promise<StoredCase> {
    const caseId = validateCaseId(id);
    return this.run('read', async (client) => {
      const result = await client.query<StoredCase>('SELECT * FROM aegis.support_cases WHERE id = $1', [caseId]);
      if (!result.rows[0]) throw new CaseStorageError('not_found');
      return result.rows[0];
    });
  }
  async update(id: unknown, status: unknown): Promise<StoredCase> {
    const caseId = validateCaseId(id);
    const nextStatus = validateStatus(status);
    return this.run('update', async (client) => {
      const result = await client.query<StoredCase>('UPDATE aegis.support_cases SET status = $1 WHERE id = $2 RETURNING *',
        [nextStatus, caseId]);
      if (!result.rows[0]) throw new CaseStorageError('not_found');
      return result.rows[0];
    });
  }
  async audit(id: unknown): Promise<AuditEvent[]> {
    const caseId = validateCaseId(id);
    return this.run('audit', async (client) => (await client.query<AuditEvent>(
      'SELECT * FROM aegis.audit_events WHERE case_id = $1 ORDER BY occurred_at, id LIMIT 100', [caseId])).rows);
  }
  async triage(id: unknown) { return triageCase((await this.read(id)).synthetic_case_id); }
}

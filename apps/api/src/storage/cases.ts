import type { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { triageCase } from '../triage.js';
import type { DevelopmentFixture } from './config.js';
import { withTenantTransaction } from './database.js';
import { CaseStorageError, validateCaseId, validateStatus, validateSyntheticCase, type StoredCase, type AuditEvent } from './models.js';
import { createCase, listCases, readCase, updateCase } from './queries.js';
export * from './models.js';

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
    return this.run('create', (client) => createCase(client, this.fixture.tenantId, caseId));
  }
  async list(): Promise<StoredCase[]> {
    return this.run('list', listCases);
  }
  async read(id: unknown): Promise<StoredCase> {
    const caseId = validateCaseId(id);
    return this.run('read', (client) => readCase(client, caseId));
  }
  async update(id: unknown, status: unknown): Promise<StoredCase> {
    const caseId = validateCaseId(id);
    const nextStatus = validateStatus(status);
    return this.run('update', (client) => updateCase(client, caseId, nextStatus));
  }
  async audit(id: unknown): Promise<AuditEvent[]> {
    const caseId = validateCaseId(id);
    return this.run('audit', async (client) => (await client.query<AuditEvent>(
      'SELECT * FROM aegis.audit_events WHERE case_id = $1 ORDER BY occurred_at, id LIMIT 100', [caseId])).rows);
  }
  async triage(id: unknown) { return triageCase((await this.read(id)).synthetic_case_id); }
}

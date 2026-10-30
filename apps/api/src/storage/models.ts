import { syntheticCases, type SyntheticCaseId } from '../contracts/triage.js';

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

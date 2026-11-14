import type { PoolClient } from 'pg';
import { CaseReviewConflictError, CaseStorageError, validateCaseId, validateStatus, validateSyntheticCase,
  type CaseReview, type CaseReviewDecision, type StoredCase } from './models.js';

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

export async function createCaseReview(client: PoolClient, tenantId: string, caseId: unknown, decision: CaseReviewDecision,
  note: string | null, idempotencyKey: string, actorIssuer: string, actorSubject: string): Promise<{ review: CaseReview; created: boolean }> {
  const reviewTenant = validateCaseId(tenantId);
  const reviewId = validateCaseId(caseId);
  const values = [reviewTenant, reviewId, decision, note, idempotencyKey];
  const inserted = await client.query<CaseReview>(`INSERT INTO aegis.case_reviews
    (tenant_id, case_id, decision, note, idempotency_key) VALUES ($1,$2,$3,$4,$5)
    ON CONFLICT (tenant_id, case_id, idempotency_key) DO NOTHING
    RETURNING review_id, tenant_id, case_id, decision, actor_issuer, actor_subject, note, created_at`, values);
  if (inserted.rows[0]) return { review: inserted.rows[0], created: true };
  const existing = await client.query<CaseReview>(`SELECT review_id, tenant_id, case_id, decision,
    actor_issuer, actor_subject, note, created_at FROM aegis.case_reviews
    WHERE tenant_id = $1 AND case_id = $2 AND idempotency_key = $3`, [reviewTenant, reviewId, idempotencyKey]);
  const review = existing.rows[0];
  if (!review || review.actor_issuer !== actorIssuer || review.actor_subject !== actorSubject ||
    review.decision !== decision || review.note !== note) throw new CaseReviewConflictError();
  return { review, created: false };
}

export async function listCaseReviews(client: PoolClient, caseId: unknown): Promise<CaseReview[]> {
  return (await client.query<CaseReview>(`SELECT review_id, tenant_id, case_id, decision, actor_issuer,
    actor_subject, note, created_at FROM (
      SELECT review_id, tenant_id, case_id, decision, actor_issuer, actor_subject, note, created_at
      FROM aegis.case_reviews WHERE case_id = $1 ORDER BY created_at DESC, review_id DESC LIMIT 100
    ) recent_reviews ORDER BY created_at, review_id`, [validateCaseId(caseId)])).rows;
}

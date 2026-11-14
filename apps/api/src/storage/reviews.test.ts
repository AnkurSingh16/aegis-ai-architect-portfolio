import { describe, expect, it, vi } from 'vitest';
import type { PoolClient } from 'pg';
import { CaseReviewConflictError } from './models.js';
import { createCaseReview, listCaseReviews } from './queries.js';

const tenant = '10000000-0000-4000-8000-000000000001';
const caseId = '12345678-1234-4234-8234-123456789abc';
const key = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const row = { review_id: '22345678-1234-4234-8234-123456789abc', tenant_id: tenant, case_id: caseId,
  decision: 'approve' as const, actor_issuer: 'https://synthetic.auth0.example/', actor_subject: 'auth0|operator',
  note: 'Synthetic review.', created_at: new Date('2026-11-14T12:00:00Z') };
function client(query: ReturnType<typeof vi.fn>) { return { query } as unknown as PoolClient; }

describe('case review storage queries', () => {
  it('inserts only client decision fields and returns database-attributed identity and time', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [row] });
    const result = await createCaseReview(client(query), tenant, caseId, 'approve', row.note, key,
      row.actor_issuer, row.actor_subject);
    expect(result).toEqual({ review: row, created: true });
    const sql = query.mock.calls[0]?.[0] as string;
    expect(sql).toContain('ON CONFLICT (tenant_id, case_id, idempotency_key) DO NOTHING');
    expect(sql.split('VALUES')[0]).not.toContain('actor_issuer');
    expect(query.mock.calls[0]?.[1]).toEqual([tenant, caseId, 'approve', row.note, key]);
  });

  it('replays the exact same actor and payload without duplicating a row', async () => {
    const query = vi.fn().mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [row] });
    const result = await createCaseReview(client(query), tenant, caseId, 'approve', row.note, key,
      row.actor_issuer, row.actor_subject);
    expect(result).toEqual({ review: row, created: false });
    expect(query).toHaveBeenCalledTimes(2);
  });

  it('rejects an idempotency key reused by a different actor or payload', async () => {
    const query = vi.fn().mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [row] });
    await expect(createCaseReview(client(query), tenant, caseId, 'approve', row.note, key,
      row.actor_issuer, 'auth0|different-actor')).rejects.toBeInstanceOf(CaseReviewConflictError);
  });

  it('returns only the newest bounded history in deterministic chronological order', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [row] });
    await expect(listCaseReviews(client(query), caseId)).resolves.toEqual([row]);
    expect(query.mock.calls[0]?.[0]).toContain('ORDER BY created_at DESC, review_id DESC LIMIT 100');
    expect(query.mock.calls[0]?.[0]).toContain('recent_reviews ORDER BY created_at, review_id');
    expect(query.mock.calls[0]?.[1]).toEqual([caseId]);
  });
});

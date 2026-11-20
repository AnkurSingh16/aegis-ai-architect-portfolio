import { describe, expect, it } from 'vitest';
import { createPostgresApprovalStore, type TenantQueryable } from './tool-approval-store.js';

const TENANT = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const APPROVAL = '33333333-3333-4333-8333-333333333333';
const NOW = new Date('2026-11-19T10:00:00Z');

interface Call { tenantId: string; text: string; values: readonly unknown[] }

/** Fake tenant runner: records every statement and returns scripted results. */
function fakeRunner(respond: (text: string) => { rows: Record<string, unknown>[]; rowCount: number | null }) {
  const calls: Call[] = [];
  const runner = async <T>(tenantId: string, operation: (client: TenantQueryable) => Promise<T>): Promise<T> =>
    operation({
      query: async <R extends Record<string, unknown>>(text: string, values: readonly unknown[]) => {
        calls.push({ tenantId, text, values });
        const result = respond(text);
        return { rows: result.rows as R[], rowCount: result.rowCount };
      },
    });
  return { runner, calls };
}

describe('postgres approval store (unit, fake client)', () => {
  it('runs every operation inside the tenant context it was given', async () => {
    const { runner, calls } = fakeRunner(() => ({ rows: [], rowCount: 0 }));
    const store = createPostgresApprovalStore(runner);
    await store.get(APPROVAL, TENANT);
    await store.consume(APPROVAL, TENANT, NOW);
    expect(calls.map((c) => c.tenantId)).toEqual([TENANT, TENANT]);
  });

  it('maps a stored row to an approval record', async () => {
    const { runner } = fakeRunner(() => ({
      rows: [{ approval_id: APPROVAL, tenant_id: TENANT, action_digest: 'a'.repeat(64), status: 'approved', approved_by: 'reviewer-9', expires_at: NOW }],
      rowCount: 1,
    }));
    expect(await createPostgresApprovalStore(runner).get(APPROVAL, TENANT)).toEqual({
      approvalId: APPROVAL, tenantId: TENANT, actionDigest: 'a'.repeat(64), status: 'approved', approvedBy: 'reviewer-9', expiresAt: NOW,
    });
  });

  it('returns undefined when no row matches the tenant', async () => {
    const { runner } = fakeRunner(() => ({ rows: [], rowCount: 0 }));
    expect(await createPostgresApprovalStore(runner).get(APPROVAL, OTHER)).toBeUndefined();
  });

  it('consumes atomically: true only when exactly one row changed, with the state conditions in the statement', async () => {
    const won = fakeRunner(() => ({ rows: [{ approval_id: APPROVAL }], rowCount: 1 }));
    expect(await createPostgresApprovalStore(won.runner).consume(APPROVAL, TENANT, NOW)).toBe(true);
    expect(won.calls[0]!.text).toMatch(/status = 'approved' AND expires_at > \$3/);
    expect(won.calls[0]!.text).toMatch(/SET status = 'consumed'/);

    const lost = fakeRunner(() => ({ rows: [], rowCount: 0 }));
    expect(await createPostgresApprovalStore(lost.runner).consume(APPROVAL, TENANT, NOW)).toBe(false);
  });

  it('approves only pending requests by a different approver', async () => {
    const { runner, calls } = fakeRunner(() => ({ rows: [], rowCount: 1 }));
    expect(await createPostgresApprovalStore(runner).approve(APPROVAL, TENANT, 'reviewer-9', NOW)).toBe(true);
    expect(calls[0]!.text).toMatch(/status = 'pending'/);
    expect(calls[0]!.text).toMatch(/requested_by <> \$3/);
  });

  it('creates pending approvals only', async () => {
    const { runner, calls } = fakeRunner(() => ({ rows: [{ approval_id: APPROVAL }], rowCount: 1 }));
    const id = await createPostgresApprovalStore(runner).create({
      tenantId: TENANT, toolName: 'case.close', actionDigest: 'b'.repeat(64), requestedBy: 'user-1', expiresAt: NOW,
    });
    expect(id).toBe(APPROVAL);
    expect(calls[0]!.text).toMatch(/'pending'/);
  });

  it('rejects malformed identifiers before any query runs', async () => {
    const { runner, calls } = fakeRunner(() => ({ rows: [], rowCount: 0 }));
    const store = createPostgresApprovalStore(runner);
    await expect(store.get('not-a-uuid', TENANT)).rejects.toThrow(RangeError);
    await expect(store.consume(APPROVAL, 'tenant-a', NOW)).rejects.toThrow(RangeError);
    expect(calls).toHaveLength(0);
  });
});

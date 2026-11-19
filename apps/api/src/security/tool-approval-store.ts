import type { ApprovalRecord, ApprovalStore } from './tool-policy-gateway.js';

/** Minimal query surface, so the store can run inside a tenant-scoped transaction supplied by the caller. */
export interface TenantQueryable {
  query<R extends Record<string, unknown>>(text: string, values: readonly unknown[]): Promise<{ rows: R[]; rowCount: number | null }>;
}

/**
 * Runs an operation in one transaction with the tenant context set for row-level security.
 * Production code supplies an authenticated runner. Tests supply a fake.
 */
export type TenantRunner = <T>(tenantId: string, operation: (client: TenantQueryable) => Promise<T>) => Promise<T>;

export interface NewApproval {
  readonly tenantId: string;
  readonly toolName: string;
  readonly actionDigest: string;
  readonly requestedBy: string;
  readonly expiresAt: Date;
}

export interface ApprovalAdministration {
  create(input: NewApproval): Promise<string>;
  /** Returns true only when a pending, unexpired approval was approved by someone other than the requester. */
  approve(approvalId: string, tenantId: string, approver: string, now: Date): Promise<boolean>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function assertUuid(value: string, label: string): void {
  if (!UUID.test(value)) throw new RangeError(`${label} must be a UUID`);
}

interface ApprovalRow extends Record<string, unknown> {
  approval_id: string; tenant_id: string; action_digest: string; status: ApprovalRecord['status'];
  approved_by: string | null; expires_at: Date;
}

/**
 * Postgres-backed approvals. Every state change is a single conditional statement, so concurrent
 * consumers cannot both succeed. The database trigger (migration 007) also rejects illegal transitions.
 */
export function createPostgresApprovalStore(runTenant: TenantRunner): ApprovalStore & ApprovalAdministration {
  return {
    async get(approvalId, tenantId) {
      assertUuid(approvalId, 'approvalId');
      assertUuid(tenantId, 'tenantId');
      return runTenant(tenantId, async (client) => {
        const result = await client.query<ApprovalRow>(
          `SELECT approval_id, tenant_id, action_digest, status, approved_by, expires_at
             FROM aegis.tool_approvals WHERE approval_id = $1 AND tenant_id = $2`,
          [approvalId, tenantId],
        );
        const row = result.rows[0];
        if (!row) return undefined;
        return {
          approvalId: row.approval_id,
          tenantId: row.tenant_id,
          actionDigest: row.action_digest,
          status: row.status,
          approvedBy: row.approved_by ?? '',
          expiresAt: row.expires_at,
        };
      });
    },

    async consume(approvalId, tenantId, now) {
      assertUuid(approvalId, 'approvalId');
      assertUuid(tenantId, 'tenantId');
      return runTenant(tenantId, async (client) => {
        const result = await client.query<{ approval_id: string }>(
          `UPDATE aegis.tool_approvals SET status = 'consumed', consumed_at = $3
            WHERE approval_id = $1 AND tenant_id = $2 AND status = 'approved' AND expires_at > $3
            RETURNING approval_id`,
          [approvalId, tenantId, now],
        );
        return (result.rowCount ?? 0) === 1;
      });
    },

    async create(input) {
      assertUuid(input.tenantId, 'tenantId');
      return runTenant(input.tenantId, async (client) => {
        const result = await client.query<{ approval_id: string }>(
          `INSERT INTO aegis.tool_approvals (tenant_id, tool_name, action_digest, status, requested_by, expires_at)
           VALUES ($1, $2, $3, 'pending', $4, $5) RETURNING approval_id`,
          [input.tenantId, input.toolName, input.actionDigest, input.requestedBy, input.expiresAt],
        );
        const id = result.rows[0]?.approval_id;
        if (!id) throw new Error('approval was not created');
        return id;
      });
    },

    async approve(approvalId, tenantId, approver, now) {
      assertUuid(approvalId, 'approvalId');
      assertUuid(tenantId, 'tenantId');
      return runTenant(tenantId, async (client) => {
        const result = await client.query<{ approval_id: string }>(
          `UPDATE aegis.tool_approvals SET status = 'approved', approved_by = $3, decided_at = $4
            WHERE approval_id = $1 AND tenant_id = $2 AND status = 'pending' AND expires_at > $4
              AND requested_by <> $3
            RETURNING approval_id`,
          [approvalId, tenantId, approver, now],
        );
        return (result.rowCount ?? 0) === 1;
      });
    },
  };
}

import type { TenantRunner } from '../security/tool-approval-store.js';
import { type ExecutionState, nextState as transitionTo } from './execution-state.js';

/** Postgres-backed execution state. Every lease-holding write is conditional on the lease owner and the expected version. */

export class StaleLeaseError extends Error {
  readonly name = 'StaleLeaseError';
}

export interface ExecutionRow {
  readonly executionId: string;
  readonly state: ExecutionState;
  readonly attempts: number;
  readonly maxAttempts: number;
  readonly version: number;
  readonly nextAttemptAt: Date | null;
  readonly cancelRequested: boolean;
  readonly approvalId: string | null;
  readonly approvalGranted: boolean;
  readonly lastErrorClass: 'retryable' | 'permanent' | 'timeout' | 'cancelled' | null;
  /** Set once, when the execution is created by the first request. Later requests with the same key do not change it. */
  readonly correlationId: string | null;
}

export interface DeadLetterRow {
  readonly executionId: string;
  readonly attempts: number;
  readonly maxAttempts: number;
  readonly lastErrorClass: 'retryable' | 'permanent' | 'timeout' | 'cancelled' | null;
  readonly updatedAt: Date;
}

export interface CheckpointRow {
  readonly seq: number;
  readonly state: ExecutionState;
  readonly attempts: number;
}

export type ApprovalChange =
  | { readonly kind: 'keep' }
  | { readonly kind: 'request'; readonly approvalId: string }
  | { readonly kind: 'grant' }
  | { readonly kind: 'consume' };

export interface TransitionInput {
  readonly executionId: string;
  readonly tenantId: string;
  readonly owner: string;
  readonly expectedVersion: number;
  readonly state: ExecutionState;
  readonly attempts: number;
  readonly nextAttemptAt: Date | null;
  readonly lastErrorClass: 'retryable' | 'permanent' | 'timeout' | 'cancelled' | null;
  /** Keep the lease while the attempt is running; release it at every other transition. */
  readonly keepLease: boolean;
  readonly leaseExpiresAt: Date;
  readonly now: Date;
  readonly approval?: ApprovalChange;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const assertUuid = (value: string, label: string): void => {
  if (!UUID.test(value)) throw new RangeError(`${label} must be a UUID`);
};

interface ExecutionDbRow extends Record<string, unknown> {
  execution_id: string; state: ExecutionState; attempts: number; max_attempts: number; version: number;
  next_attempt_at: Date | null; cancel_requested: boolean; approval_id: string | null; approval_granted: boolean;
  last_error_class: ExecutionRow['lastErrorClass']; updated_at: Date; correlation_id: string | null;
}

const SELECT_EXECUTION = `execution_id, state, attempts, max_attempts, version, next_attempt_at,
  cancel_requested, approval_id, approval_granted, last_error_class, correlation_id`;

const toRow = (row: ExecutionDbRow): ExecutionRow => ({
  executionId: row.execution_id, state: row.state, attempts: row.attempts, maxAttempts: row.max_attempts,
  version: row.version, nextAttemptAt: row.next_attempt_at, cancelRequested: row.cancel_requested,
  approvalId: row.approval_id, approvalGranted: row.approval_granted, lastErrorClass: row.last_error_class,
  correlationId: row.correlation_id,
});

/** Approval column values for a transition. Keeps the current value unless the change says otherwise. */
function approvalColumns(change: ApprovalChange | undefined): { setId: boolean; id: string | null; setGranted: boolean; granted: boolean } {
  switch (change?.kind) {
    case 'request': return { setId: true, id: change.approvalId, setGranted: true, granted: false };
    case 'grant': return { setId: false, id: null, setGranted: true, granted: true };
    case 'consume': return { setId: false, id: null, setGranted: true, granted: false };
    default: return { setId: false, id: null, setGranted: false, granted: false };
  }
}

export type RequeueOutcome =
  | { readonly outcome: 'requeued'; readonly version: number; readonly attempts: number }
  | { readonly outcome: 'not_found' }
  | { readonly outcome: 'not_failed' };

export function createDurableStore(runTenant: TenantRunner) {
  return {
    /** Idempotent on (tenant, key): a repeated request returns the existing execution with created = false. */
    async createExecution(tenantId: string, idempotencyKey: string, maxAttempts: number, correlationId: string | null = null): Promise<{ executionId: string; created: boolean }> {
      assertUuid(tenantId, 'tenantId');
      if (idempotencyKey.length === 0 || idempotencyKey.length > 200) throw new RangeError('idempotency key must be 1 to 200 characters');
      return runTenant(tenantId, async (client) => {
        const inserted = await client.query<{ execution_id: string }>(
          `INSERT INTO aegis.workflow_executions (tenant_id, idempotency_key, state, max_attempts, correlation_id)
           VALUES ($1, $2, 'pending', $3, $4) ON CONFLICT (tenant_id, idempotency_key) DO NOTHING RETURNING execution_id`,
          [tenantId, idempotencyKey, maxAttempts, correlationId],
        );
        if (inserted.rows[0]) return { executionId: inserted.rows[0].execution_id, created: true };
        const existing = await client.query<{ execution_id: string }>(
          'SELECT execution_id FROM aegis.workflow_executions WHERE tenant_id = $1 AND idempotency_key = $2',
          [tenantId, idempotencyKey],
        );
        const id = existing.rows[0]?.execution_id;
        if (!id) throw new Error('execution could not be created or found');
        return { executionId: id, created: false };
      });
    },

    /** Takes the lease only if nobody holds an unexpired one and the attempt is due. Returns null otherwise. */
    async claim(executionId: string, tenantId: string, owner: string, now: Date, leaseExpiresAt: Date): Promise<ExecutionRow | null> {
      assertUuid(executionId, 'executionId');
      assertUuid(tenantId, 'tenantId');
      return runTenant(tenantId, async (client) => {
        const result = await client.query<ExecutionDbRow>(
          `UPDATE aegis.workflow_executions
              SET lease_owner = $3, lease_expires_at = $5, updated_at = $4
            WHERE execution_id = $1 AND tenant_id = $2
              AND state IN ('pending', 'retry_wait', 'running')
              AND (lease_expires_at IS NULL OR lease_expires_at <= $4)
              AND (next_attempt_at IS NULL OR next_attempt_at <= $4)
            RETURNING ${SELECT_EXECUTION}`,
          [executionId, tenantId, owner, now, leaseExpiresAt],
        );
        return result.rows[0] ? toRow(result.rows[0]) : null;
      });
    },

    /** Moves state, bumps the version and appends a checkpoint, all in one transaction. Fails if the lease or version is stale. */
    async transition(input: TransitionInput): Promise<number> {
      assertUuid(input.executionId, 'executionId');
      assertUuid(input.tenantId, 'tenantId');
      const approval = approvalColumns(input.approval);
      return runTenant(input.tenantId, async (client) => {
        const updated = await client.query<{ version: number }>(
          `UPDATE aegis.workflow_executions
              SET state = $4, attempts = $5, next_attempt_at = $6, last_error_class = $7,
                  lease_owner = CASE WHEN $8::boolean THEN lease_owner ELSE NULL END,
                  lease_expires_at = CASE WHEN $8::boolean THEN $9::timestamptz ELSE NULL END,
                  approval_id = CASE WHEN $12::boolean THEN $13::uuid ELSE approval_id END,
                  approval_granted = CASE WHEN $14::boolean THEN $15::boolean ELSE approval_granted END,
                  version = version + 1, updated_at = $10
            WHERE execution_id = $1 AND tenant_id = $2 AND version = $3
              AND lease_owner = $11 AND lease_expires_at > $10
            RETURNING version`,
          [input.executionId, input.tenantId, input.expectedVersion, input.state, input.attempts, input.nextAttemptAt,
            input.lastErrorClass, input.keepLease, input.leaseExpiresAt, input.now, input.owner,
            approval.setId, approval.id, approval.setGranted, approval.granted],
        );
        const version = updated.rows[0]?.version;
        if (version === undefined) throw new StaleLeaseError('execution lease or version is stale');
        await client.query(
          `INSERT INTO aegis.workflow_checkpoints (execution_id, tenant_id, seq, state, attempts)
           VALUES ($1, $2, $3, $4, $5)`,
          [input.executionId, input.tenantId, version, input.state, input.attempts],
        );
        return version;
      });
    },

    /**
     * Cancels without a lease when nothing is running. If an attempt holds the lease, only the request is recorded
     * and the driver honours it when that attempt finishes.
     */
    async requestCancel(executionId: string, tenantId: string, now: Date): Promise<'cancelled' | 'cancel_requested' | 'not_found' | 'terminal'> {
      assertUuid(executionId, 'executionId');
      assertUuid(tenantId, 'tenantId');
      return runTenant(tenantId, async (client) => {
        const current = await client.query<ExecutionDbRow & { lease_held: boolean }>(
          `SELECT ${SELECT_EXECUTION}, (lease_owner IS NOT NULL AND lease_expires_at > $3) AS lease_held
             FROM aegis.workflow_executions WHERE execution_id = $1 AND tenant_id = $2`,
          [executionId, tenantId, now],
        );
        const row = current.rows[0];
        if (!row) return 'not_found';
        if (['succeeded', 'failed', 'cancelled'].includes(row.state)) return 'terminal';
        if (row.lease_held) {
          // An attempt is in flight. Record the request; the driver honours it when the attempt finishes.
          await client.query('UPDATE aegis.workflow_executions SET cancel_requested = true, updated_at = $3 WHERE execution_id = $1 AND tenant_id = $2',
            [executionId, tenantId, now]);
          return 'cancel_requested';
        }
        const cancelled = await client.query<{ version: number }>(
          `UPDATE aegis.workflow_executions
              SET state = 'cancelled', cancel_requested = true, next_attempt_at = NULL, last_error_class = 'cancelled',
                  lease_owner = NULL, lease_expires_at = NULL, approval_granted = false, version = version + 1, updated_at = $4
            WHERE execution_id = $1 AND tenant_id = $2 AND version = $3 AND state = $5
            RETURNING version`,
          [executionId, tenantId, row.version, now, row.state],
        );
        const version = cancelled.rows[0]?.version;
        if (version === undefined) return 'cancel_requested'; // another writer moved it; the flag is set for the driver
        await client.query(
          'INSERT INTO aegis.workflow_checkpoints (execution_id, tenant_id, seq, state, attempts) VALUES ($1, $2, $3, $4, $5)',
          [executionId, tenantId, version, 'cancelled', row.attempts],
        );
        return 'cancelled';
      });
    },

    async isCancelRequested(executionId: string, tenantId: string): Promise<boolean> {
      assertUuid(executionId, 'executionId');
      assertUuid(tenantId, 'tenantId');
      return runTenant(tenantId, async (client) => {
        const result = await client.query<{ cancel_requested: boolean }>(
          'SELECT cancel_requested FROM aegis.workflow_executions WHERE execution_id = $1 AND tenant_id = $2',
          [executionId, tenantId],
        );
        return result.rows[0]?.cancel_requested === true;
      });
    },

    /** Resolves an approval wait without a lease. Only an awaiting execution at the expected version can move. */
    async resolveApproval(executionId: string, tenantId: string, expectedVersion: number, outcome: 'granted' | 'rejected', now: Date): Promise<boolean> {
      assertUuid(executionId, 'executionId');
      assertUuid(tenantId, 'tenantId');
      const nextState: ExecutionState = outcome === 'granted' ? 'retry_wait' : 'cancelled';
      return runTenant(tenantId, async (client) => {
        const updated = await client.query<{ version: number; attempts: number }>(
          `UPDATE aegis.workflow_executions
              SET state = $4, approval_granted = $5, next_attempt_at = $6,
                  last_error_class = CASE WHEN $4 = 'cancelled' THEN 'cancelled' ELSE last_error_class END,
                  version = version + 1, updated_at = $6
            WHERE execution_id = $1 AND tenant_id = $2 AND version = $3 AND state = 'awaiting_approval'
            RETURNING version, attempts`,
          [executionId, tenantId, expectedVersion, nextState, outcome === 'granted', now],
        );
        const row = updated.rows[0];
        if (!row) return false;
        await client.query(
          'INSERT INTO aegis.workflow_checkpoints (execution_id, tenant_id, seq, state, attempts) VALUES ($1, $2, $3, $4, $5)',
          [executionId, tenantId, row.version, nextState, row.attempts],
        );
        return true;
      });
    },

    /**
     * Read-only view of failed executions for one tenant, newest first. There is no replay or requeue here:
     * a dead letter is a record for an operator to inspect.
     */
    async listDeadLetters(tenantId: string, limit: number): Promise<DeadLetterRow[]> {
      assertUuid(tenantId, 'tenantId');
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new RangeError('limit must be an integer from 1 to 100');
      return runTenant(tenantId, async (client) => {
        const result = await client.query<ExecutionDbRow>(
          `SELECT ${SELECT_EXECUTION}, updated_at FROM aegis.workflow_executions
            WHERE tenant_id = $1 AND state = 'failed'
            ORDER BY updated_at DESC, execution_id
            LIMIT $2`,
          [tenantId, limit],
        );
        return result.rows.map((row) => ({
          executionId: row.execution_id, attempts: row.attempts, maxAttempts: row.max_attempts,
          lastErrorClass: row.last_error_class, updatedAt: row.updated_at,
        }));
      });
    },

    /**
     * Operator requeue: moves a failed execution to retry_wait for one more attempt and writes an audited checkpoint in
     * the same transaction. Refused unless the execution is failed and no cancellation was requested. The attempt count
     * is kept. An execution that used its whole budget therefore gets exactly one more attempt, because a failure at or
     * past the budget is permanent (decideAfterFailure). One that failed permanently keeps its remaining budget, but its
     * next permanent failure ends it as before.
     */
    async requeue(executionId: string, tenantId: string, actor: string, reason: string, now: Date): Promise<RequeueOutcome> {
      assertUuid(executionId, 'executionId');
      assertUuid(tenantId, 'tenantId');
      if (actor.length === 0 || actor.length > 256) throw new RangeError('actor must be 1 to 256 characters');
      if (reason.trim().length === 0 || reason.length > 500) throw new RangeError('reason must be 1 to 500 characters');
      // The state machine is the single source of truth for this move: only 'failed' may requeue.
      if (transitionTo('failed', 'operator_requeue') !== 'retry_wait') throw new Error('operator requeue must lead to retry_wait');
      return runTenant(tenantId, async (client): Promise<RequeueOutcome> => {
        const moved = await client.query<{ version: number; attempts: number }>(
          `UPDATE aegis.workflow_executions
              SET state = 'retry_wait', next_attempt_at = $3, lease_owner = NULL, lease_expires_at = NULL,
                  version = version + 1, updated_at = $3
            WHERE execution_id = $1 AND tenant_id = $2 AND state = 'failed' AND cancel_requested = false
            RETURNING version, attempts`,
          [executionId, tenantId, now],
        );
        const row = moved.rows[0];
        if (!row) {
          const present = await client.query('SELECT 1 FROM aegis.workflow_executions WHERE execution_id = $1 AND tenant_id = $2', [executionId, tenantId]);
          return present.rows.length === 0 ? { outcome: 'not_found' } : { outcome: 'not_failed' };
        }
        await client.query(
          `INSERT INTO aegis.workflow_checkpoints (execution_id, tenant_id, seq, state, attempts, actor, reason)
           VALUES ($1, $2, $3, 'retry_wait', $4, $5, $6)`,
          [executionId, tenantId, row.version, row.attempts, actor, reason],
        );
        return { outcome: 'requeued', version: row.version, attempts: row.attempts };
      });
    },

    async load(executionId: string, tenantId: string): Promise<{ execution: ExecutionRow; checkpoints: CheckpointRow[] } | undefined> {
      assertUuid(executionId, 'executionId');
      assertUuid(tenantId, 'tenantId');
      return runTenant(tenantId, async (client) => {
        const execution = await client.query<ExecutionDbRow>(
          `SELECT ${SELECT_EXECUTION} FROM aegis.workflow_executions WHERE execution_id = $1 AND tenant_id = $2`,
          [executionId, tenantId],
        );
        const row = execution.rows[0];
        if (!row) return undefined;
        const checkpoints = await client.query<{ seq: number; state: ExecutionState; attempts: number }>(
          'SELECT seq, state, attempts FROM aegis.workflow_checkpoints WHERE execution_id = $1 AND tenant_id = $2 ORDER BY seq',
          [executionId, tenantId],
        );
        return { execution: toRow(row), checkpoints: checkpoints.rows.map((c) => ({ seq: c.seq, state: c.state, attempts: c.attempts })) };
      });
    },
  };
}

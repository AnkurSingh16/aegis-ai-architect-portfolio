import type { TenantRunner } from '../security/tool-approval-store.js';
import type { ExecutionState } from './execution-state.js';

/** Postgres-backed execution state. Every write is conditional on the lease owner and the expected version. */

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
}

export interface CheckpointRow {
  readonly seq: number;
  readonly state: ExecutionState;
  readonly attempts: number;
}

export interface TransitionInput {
  readonly executionId: string;
  readonly tenantId: string;
  readonly owner: string;
  readonly expectedVersion: number;
  readonly state: ExecutionState;
  readonly attempts: number;
  readonly nextAttemptAt: Date | null;
  readonly lastErrorClass: 'retryable' | 'permanent' | 'timeout' | null;
  /** Keep the lease while the attempt is running; release it at every other transition. */
  readonly keepLease: boolean;
  readonly leaseExpiresAt: Date;
  readonly now: Date;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const assertUuid = (value: string, label: string): void => {
  if (!UUID.test(value)) throw new RangeError(`${label} must be a UUID`);
};

interface ExecutionDbRow extends Record<string, unknown> {
  execution_id: string; state: ExecutionState; attempts: number; max_attempts: number; version: number; next_attempt_at: Date | null;
}

const toRow = (row: ExecutionDbRow): ExecutionRow => ({
  executionId: row.execution_id, state: row.state, attempts: row.attempts, maxAttempts: row.max_attempts,
  version: row.version, nextAttemptAt: row.next_attempt_at,
});

export function createDurableStore(runTenant: TenantRunner) {
  return {
    /** Idempotent on (tenant, key): a repeated request returns the existing execution with created = false. */
    async createExecution(tenantId: string, idempotencyKey: string, maxAttempts: number): Promise<{ executionId: string; created: boolean }> {
      assertUuid(tenantId, 'tenantId');
      if (idempotencyKey.length === 0 || idempotencyKey.length > 200) throw new RangeError('idempotency key must be 1 to 200 characters');
      return runTenant(tenantId, async (client) => {
        const inserted = await client.query<{ execution_id: string }>(
          `INSERT INTO aegis.workflow_executions (tenant_id, idempotency_key, state, max_attempts)
           VALUES ($1, $2, 'pending', $3) ON CONFLICT (tenant_id, idempotency_key) DO NOTHING RETURNING execution_id`,
          [tenantId, idempotencyKey, maxAttempts],
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
            RETURNING execution_id, state, attempts, max_attempts, version, next_attempt_at`,
          [executionId, tenantId, owner, now, leaseExpiresAt],
        );
        return result.rows[0] ? toRow(result.rows[0]) : null;
      });
    },

    /** Moves state, bumps the version and appends a checkpoint, all in one transaction. Fails if the lease or version is stale. */
    async transition(input: TransitionInput): Promise<number> {
      assertUuid(input.executionId, 'executionId');
      assertUuid(input.tenantId, 'tenantId');
      return runTenant(input.tenantId, async (client) => {
        const updated = await client.query<{ version: number }>(
          `UPDATE aegis.workflow_executions
              SET state = $4, attempts = $5, next_attempt_at = $6, last_error_class = $7,
                  lease_owner = CASE WHEN $8::boolean THEN lease_owner ELSE NULL END,
                  lease_expires_at = CASE WHEN $8::boolean THEN $9::timestamptz ELSE NULL END,
                  version = version + 1, updated_at = $10
            WHERE execution_id = $1 AND tenant_id = $2 AND version = $3
              AND lease_owner = $11 AND lease_expires_at > $10
            RETURNING version`,
          [input.executionId, input.tenantId, input.expectedVersion, input.state, input.attempts, input.nextAttemptAt,
            input.lastErrorClass, input.keepLease, input.leaseExpiresAt, input.now, input.owner],
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

    async load(executionId: string, tenantId: string): Promise<{ execution: ExecutionRow; checkpoints: CheckpointRow[] } | undefined> {
      assertUuid(executionId, 'executionId');
      assertUuid(tenantId, 'tenantId');
      return runTenant(tenantId, async (client) => {
        const execution = await client.query<ExecutionDbRow>(
          'SELECT execution_id, state, attempts, max_attempts, version, next_attempt_at FROM aegis.workflow_executions WHERE execution_id = $1 AND tenant_id = $2',
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

import type { Pool } from 'pg';
import { createAgentExecutionStore, joinTransaction, type CancellationFailureClass, type ExecutionHooks } from '../persistence/execution-store.js';
import { withMessagingContext } from './context.js';

/**
 * Orchestrator-owned cancellation reconciliation (migrations 024 and 025). The orchestrator's runtime loop and the integration tests both
 * call this one function, so the tests exercise production behaviour.
 *
 * Each cycle:
 * 1. discovers at most `limit` cancellations that are requested, non-terminal and DUE (next attempt time reached), in next-attempt order.
 *    A failed cancellation moves to a later time, so it cannot hold a discovery slot while it is backing off;
 * 2. finalises each candidate in its own transaction under the execution row lock, with lock and statement timeouts;
 * 3. on failure, records the attempt in a SEPARATE transaction, so a rolled-back finalisation cannot erase the failure record.
 *
 * Failure classes:
 * - transient (lock timeout, statement timeout, serialisation, connection loss, unclassified): recorded, retried at the backoff cap;
 * - execution_refused (the execution is not visible in its tenant): recorded;
 * - systemic (privilege, missing function or relation, authentication): NOT recorded against the row, because the fault is not the row's.
 *   The cycle halts, so one broken configuration does not spin through the whole queue.
 * A cycle also halts when a failure cannot be recorded, because the database is then not making progress.
 */
/** One discovered candidate. The generation is a decimal string: a bigint is never converted to a JavaScript number. */
interface DueRow {
  readonly tenant_id: string;
  readonly execution_id: string;
  readonly cancellation_attempts: number;
  readonly cancellation_generation: string;
}

export interface ReconcileSummary {
  readonly candidates: number;
  readonly applied: number;
  readonly skipped: number;
  readonly refused: number;
  readonly transient: number;
  /** Lock or statement timeout: not recorded, retried at the next cycle, does not halt the cycle. */
  readonly deferred: number;
  readonly systemic: number;
  readonly unrecorded: number;
  readonly halted: boolean;
}

export interface ReconcileOptions {
  readonly instance: string;
  readonly limit?: number;
  readonly lockTimeoutMs?: number;
  readonly statementTimeoutMs?: number;
  /**
   * Test seam only: deterministic fault injection and gating for the finalisation ('finalise') and failure-recording ('record')
   * transactions. It runs inside the transaction, after discovery and before the row lock is taken. It may await, so a test can hold
   * two reconcilers at the same point. The runtime never passes it, and nothing environment-controlled reaches it.
   */
  readonly injectFault?: (phase: 'finalise' | 'record', tenantId: string, executionId: string) => Error | undefined | Promise<Error | undefined>;
}

/** Documented retry policy (also stated in migration 025 and docs/SECURITY-TENANT-BOUNDARIES.md). */
export const CANCELLATION_RETRY = { initialBackoffSeconds: 1, maxBackoffSeconds: 60, maxStoredAttempts: 1000 } as const;

/** Errors that name a configuration or privilege fault rather than a row or timing fault. */
const SYSTEMIC_CODES = new Set(['42501', '42883', '42P01', '42703', '28000', '28P01', '3D000']);

type RowOutcome = 'applied' | 'skipped' | 'refused' | 'transient' | 'deferred' | 'systemic' | 'unrecorded';

function clampInt(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

export function classifyFailure(error: unknown): 'transient' | 'systemic' {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && SYSTEMIC_CODES.has(code) ? 'systemic' : 'transient';
}

export async function reconcileCancellations(pool: Pool, hooks: ExecutionHooks, options: ReconcileOptions): Promise<ReconcileSummary> {
  const limit = clampInt(options.limit ?? 10, 1, 50);
  const lockMs = clampInt(options.lockTimeoutMs ?? 2000, 100, 30000);
  const statementMs = clampInt(options.statementTimeoutMs ?? 5000, 100, 60000);
  const due = await pool.query<DueRow>(
    'SELECT tenant_id, execution_id, cancellation_attempts, cancellation_generation::text AS cancellation_generation FROM aegis.orchestrator_due_cancellations($1)', [limit]);
  const totals = { applied: 0, skipped: 0, refused: 0, transient: 0, deferred: 0, systemic: 0, unrecorded: 0 };
  let halted = false;
  for (const row of due.rows) {
    const outcome = await attemptOne(pool, hooks, row, options, lockMs, statementMs);
    totals[outcome] += 1;
    // Systemic faults and unrecordable failures stop the cycle. A deferred row (lock or statement timeout) does not: an unrelated
    // locked execution must not stall the cancellations behind it. It stays due and is retried at the next cycle.
    if (outcome === 'systemic' || outcome === 'unrecorded') { halted = true; break; }
  }
  return { candidates: due.rows.length, ...totals, halted };
}

const TIMEOUT_CODES = new Set(['55P03', '57014']);

async function attemptOne(pool: Pool, hooks: ExecutionHooks, row: DueRow,
  options: ReconcileOptions, lockMs: number, statementMs: number): Promise<RowOutcome> {
  const { tenant_id: tenantId, execution_id: executionId } = row;
  let failure: CancellationFailureClass;
  try {
    const result = await withMessagingContext(pool, { tenantId }, async (client) => {
      await client.query(`SET LOCAL lock_timeout = ${lockMs}`, []);
      await client.query(`SET LOCAL statement_timeout = ${statementMs}`, []);
      const injected = await options.injectFault?.('finalise', tenantId, executionId);
      if (injected) throw injected;
      return createAgentExecutionStore(joinTransaction(client, tenantId), hooks).finaliseCancellation(tenantId, executionId, options.instance);
    });
    if (result.ok) return result.value.applied ? 'applied' : 'skipped';
    failure = 'execution_refused';
  } catch (error) {
    if (classifyFailure(error) === 'systemic') return 'systemic';
    failure = 'transient';
  }
  try {
    const injected = await options.injectFault?.('record', tenantId, executionId);
    if (injected) throw injected;
    // The record takes the same row lock, so it carries the same timeout: an unrelated lock must not stall the whole cycle.
    const recorded = await withMessagingContext(pool, { tenantId }, async (client) => {
      await client.query(`SET LOCAL lock_timeout = ${lockMs}`, []);
      await client.query(`SET LOCAL statement_timeout = ${statementMs}`, []);
      return createAgentExecutionStore(joinTransaction(client, tenantId), hooks).recordCancellationFailure(tenantId, executionId, failure, row.cancellation_generation);
    });
    if (!recorded.recorded) return 'skipped';
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code;
    return typeof code === 'string' && TIMEOUT_CODES.has(code) ? 'deferred' : 'unrecorded';
  }
  return failure === 'transient' ? 'transient' : 'refused';
}

export interface CancellationBacklog {
  readonly pending: number;
  readonly overdue: number;
  readonly failing: number;
  readonly maxAttempts: number;
  readonly oldestRequestAgeSeconds: number;
}

/** Aggregate counts and ages only, across tenants. No identifiers. Orchestrator-only (migration 025). */
export async function readCancellationBacklog(pool: Pool): Promise<CancellationBacklog> {
  const result = await pool.query<{ pending: number; overdue: number; failing: number; max_attempts: number;
    oldest_request_age_seconds: number }>(
    `SELECT pending::int AS pending, overdue::int AS overdue, failing::int AS failing, max_attempts,
            oldest_request_age_seconds FROM aegis.orchestrator_cancellation_backlog()`, []);
  const row = result.rows[0];
  return { pending: row.pending, overdue: row.overdue, failing: row.failing, maxAttempts: row.max_attempts,
    oldestRequestAgeSeconds: Math.round(row.oldest_request_age_seconds) };
}

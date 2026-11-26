import type { Pool } from 'pg';
import { createAgentExecutionStore, joinTransaction, type ExecutionHooks } from '../persistence/execution-store.js';
import { withMessagingContext } from './context.js';

/**
 * Orchestrator-owned cancellation reconciliation. The orchestrator's runtime loop and the integration tests both call this one function,
 * so the tests exercise the production behaviour.
 *
 * Each cycle discovers at most `limit` executions whose cancellation is requested and not yet finalised (migration 024), then finalises
 * each in its own transaction under the execution row lock (store.finaliseCancellation). A cancellation therefore never waits for a
 * message from another agent, and an execution that is already terminal is left alone. Repeating a cycle changes nothing: a finalised
 * execution is terminal and is not discovered again. One failing execution is counted and does not stop the others.
 */
export interface ReconcileSummary { readonly candidates: number; readonly applied: number; readonly refused: number }

export async function reconcileCancellations(pool: Pool, hooks: ExecutionHooks, options: { instance: string; limit?: number }):
  Promise<ReconcileSummary> {
  const limit = Math.max(1, Math.min(options.limit ?? 10, 50));
  const found = await pool.query<{ tenant_id: string; execution_id: string }>(
    'SELECT tenant_id, execution_id FROM aegis.orchestrator_pending_cancellations($1)', [limit]);
  let applied = 0;
  let refused = 0;
  for (const row of found.rows) {
    try {
      const result = await withMessagingContext(pool, { tenantId: row.tenant_id }, (client) =>
        createAgentExecutionStore(joinTransaction(client, row.tenant_id), hooks).finaliseCancellation(row.tenant_id, row.execution_id, options.instance));
      if (!result.ok) refused += 1;
      else if (result.value.applied) applied += 1;
    } catch {
      refused += 1;
    }
  }
  return { candidates: found.rows.length, applied, refused };
}

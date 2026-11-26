import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { createDatabasePool } from '../../storage/database.js';
import { requestCancellation } from '../../investigation/gateway.js';
import { withMessagingContext } from '../messaging/context.js';
import { closeHarness, createHarness, NORTH, readerPrincipal, roleUrl, startInvestigation, type Harness } from '../messaging/testing/support.js';

// Remediation 4 (migration 023) on real PostgreSQL, through the same agent roles the runtimes use. Each negative
// test asserts the database refusal, and each legitimate path asserts that the workflow still works.

let h: Harness;
let north: { executionId: string };
let cancelled: { executionId: string };
let adminCheck: Pool;

type Rows = { rows: Record<string, unknown>[] };
type ScopedClient = { query: (sql: string, values?: unknown[]) => Promise<Rows> };
const inScope = (pool: Pool, tenant: string, operation: (client: ScopedClient) => Promise<Rows>): Promise<Rows> =>
  withMessagingContext(pool, { tenantId: tenant }, operation as never) as Promise<Rows>;

beforeAll(async () => {
  h = await createHarness();
  adminCheck = new Pool({ connectionString: process.env.TEST_DATABASE_ADMIN_URL, max: 1 });
  north = await startInvestigation(h, { tenantId: NORTH });
  cancelled = await startInvestigation(h, { tenantId: NORTH });
});

afterAll(async () => {
  await adminCheck?.end();
  if (h) await closeHarness(h);
});

describe('remediation 4: cancellation is enforced in the database', () => {
  it('a cancelled execution cannot be moved to a final approved state', async () => {
    await requestCancellation((tenant, op) => withMessagingContext(h.pools.gateway, { tenantId: tenant }, op),
      readerPrincipal(), { tenantId: NORTH, executionId: cancelled.executionId, reason: 'user_request' });
    const stages = ['triage_requested', 'plan_received', 'retrieval_requested', 'evidence_received', 'review_requested', 'review_received'];
    for (const stage of stages) {
      await inScope(h.pools.orchestrator, NORTH, (c) => c.query('UPDATE aegis.agent_executions SET workflow_stage = $2 WHERE execution_id = $1', [cancelled.executionId, stage]));
    }
    expect((await adminCheck.query<{ workflow_stage: string }>('SELECT workflow_stage FROM aegis.agent_executions WHERE execution_id = $1', [cancelled.executionId])).rows[0].workflow_stage).toBe('review_received');
    await expect(inScope(h.pools.orchestrator, NORTH, (c) => c.query(
      `UPDATE aegis.agent_executions SET workflow_stage = 'completed' WHERE execution_id = $1`, [cancelled.executionId])))
      .rejects.toThrow(/cannot complete|not permitted/);
  });

  it('a request already addressed to a participant cannot be consumed after cancellation is recorded', async () => {
    const grant = await adminCheck.query<{ grant_id: string }>(
      `SELECT grant_id FROM aegis.agent_grants WHERE execution_id = $1 AND kind = 'request' AND to_agent = 'triage' AND status = 'open'`, [cancelled.executionId]);
    expect(grant.rows).toHaveLength(1);
    await expect(inScope(h.pools.triage, NORTH, (c) => c.query(
      `UPDATE aegis.agent_grants SET status = 'consumed', consumed_by_agent = 'triage' WHERE grant_id = $1`, [grant.rows[0].grant_id])))
      .rejects.toThrow(/cannot be consumed after cancellation|row-level security/);
  });

  it('cancellation state persists in the database and is visible to a new session (runtime recovery)', async () => {
    const recovered = createDatabasePool(roleUrl('orchestrator'), 1);
    try {
      const rows = await inScope(recovered, NORTH, (c) => c.query(
        'SELECT cancel_requested FROM aegis.agent_executions WHERE execution_id = $1', [cancelled.executionId]));
      expect(rows.rows).toEqual([{ cancel_requested: true }]);
    } finally { await recovered.end(); }
  });

  it('an execution that was never cancelled completes after an approved review (legitimate path unchanged)', async () => {
    const stages = ['triage_requested', 'plan_received', 'retrieval_requested', 'evidence_received', 'review_requested', 'review_received', 'completed'];
    for (const stage of stages) {
      await inScope(h.pools.orchestrator, NORTH, (c) => c.query('UPDATE aegis.agent_executions SET workflow_stage = $2 WHERE execution_id = $1', [north.executionId, stage]));
    }
    expect((await adminCheck.query<{ workflow_stage: string; cancel_requested: boolean }>('SELECT workflow_stage, cancel_requested FROM aegis.agent_executions WHERE execution_id = $1', [north.executionId])).rows)
      .toEqual([{ workflow_stage: 'completed', cancel_requested: false }]);
  });
});

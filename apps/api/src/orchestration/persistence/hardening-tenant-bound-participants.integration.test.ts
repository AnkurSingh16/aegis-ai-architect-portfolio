import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { withMessagingContext } from '../messaging/context.js';
import { closeHarness, createHarness, NORTH, SOUTH, startInvestigation, type Harness } from '../messaging/testing/support.js';

// Remediations 2, 3 and 4 (migrations 021, 022, 023) on real PostgreSQL, through the same agent roles the runtimes use. Each negative
// test asserts the database refusal, and each legitimate path asserts that the workflow still works.

let h: Harness;
let north: { executionId: string };
let adminCheck: Pool;

type Rows = { rows: Record<string, unknown>[] };
type ScopedClient = { query: (sql: string, values?: unknown[]) => Promise<Rows> };
const inScope = (pool: Pool, tenant: string, operation: (client: ScopedClient) => Promise<Rows>): Promise<Rows> =>
  withMessagingContext(pool, { tenantId: tenant }, operation as never) as Promise<Rows>;

beforeAll(async () => {
  h = await createHarness();
  adminCheck = new Pool({ connectionString: process.env.TEST_DATABASE_ADMIN_URL, max: 1 });
  north = await startInvestigation(h, { tenantId: NORTH });
});

afterAll(async () => {
  await adminCheck?.end();
  if (h) await closeHarness(h);
});

describe('remediation 2: participant access is bound to the tenant as well as to participation', () => {
  it('a triage session scoped to the other tenant cannot read a North execution, its delegations or its grants', async () => {
    const execution = await inScope(h.pools.triage, SOUTH, (c) => c.query('SELECT execution_id FROM aegis.agent_executions WHERE execution_id = $1', [north.executionId]));
    const delegations = await inScope(h.pools.triage, SOUTH, (c) => c.query('SELECT seq FROM aegis.agent_delegations WHERE execution_id = $1', [north.executionId]));
    const grants = await inScope(h.pools.triage, SOUTH, (c) => c.query('SELECT grant_id FROM aegis.agent_grants WHERE execution_id = $1', [north.executionId]));
    expect(execution.rows).toEqual([]);
    expect(delegations.rows).toEqual([]);
    expect(grants.rows).toEqual([]);
  });

  it('the same participant scoped to the execution tenant does read it (legitimate path unchanged)', async () => {
    const execution = await inScope(h.pools.triage, NORTH, (c) => c.query('SELECT execution_id FROM aegis.agent_executions WHERE execution_id = $1', [north.executionId]));
    expect(execution.rows).toHaveLength(1);
  });

  it('a participant scoped to the other tenant cannot write an execution event for a North execution', async () => {
    await expect(inScope(h.pools.triage, SOUTH, (c) => c.query(
      `INSERT INTO aegis.agent_execution_events (tenant_id, execution_id, event_type, outcome, reason, actor_agent, fencing_token)
       VALUES ($1, $2, 'execution_created', 'accepted', NULL, 'triage', 0)`, [NORTH, north.executionId]))).rejects.toThrow(/row-level security|violates|permission denied/);
  });

  it('a session cannot change its workload identity with SET ROLE (identity is the login role, not a setting)', async () => {
    const client = await h.pools.triage.connect();
    try {
      await expect(client.query('SET ROLE aegis_retrieval')).rejects.toThrow(/permission denied to set role/);
    } finally { client.release(); }
  });
});

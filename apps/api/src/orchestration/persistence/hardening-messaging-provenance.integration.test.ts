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

describe('remediation 3: messaging provenance and audit integrity', () => {
  it('the orchestrator cannot enqueue an outbox row whose sender is another agent', async () => {
    const original = await adminCheck.query<{ tenant_id: string; execution_id: string; envelope: unknown; payload: unknown; payload_digest: string }>(
      `SELECT tenant_id, execution_id, envelope, payload, payload_digest FROM aegis.agent_outbox
        WHERE execution_id = $1 AND sender_agent = 'orchestrator' ORDER BY created_at LIMIT 1`, [north.executionId]);
    const row = original.rows[0];
    await expect(inScope(h.pools.orchestrator, NORTH, (c) => c.query(
      `INSERT INTO aegis.agent_outbox (tenant_id, execution_id, sender_agent, destination_agent, kind, envelope, payload, payload_digest)
       VALUES ($1, $2, 'triage', 'retrieval', 'request', $3, $4, $5)`,
      [row.tenant_id, row.execution_id, row.envelope, row.payload, row.payload_digest]))).rejects.toThrow(/row-level security/);
  });

  it('a message event cannot be labelled with another tenant, even for an execution that exists', async () => {
    await expect(inScope(h.pools.triage, SOUTH, (c) => c.query(
      `INSERT INTO aegis.agent_message_events (tenant_id, execution_id, message_id, event_type, actor_agent)
       VALUES ($1, $2, gen_random_uuid(), 'inbox_processed', 'triage')`, [NORTH, north.executionId]))).rejects.toThrow(/row-level security|violates/);
  });

  it('a message event must reference an execution of its own tenant (composite foreign key), even for a privileged session', async () => {
    await expect(adminCheck.query(
      `INSERT INTO aegis.agent_message_events (tenant_id, execution_id, message_id, event_type, actor_agent)
       VALUES ($1, gen_random_uuid(), gen_random_uuid(), 'inbox_processed', 'triage')`, [NORTH])).rejects.toThrow(/agent_message_events_execution_fk/);
  });
});

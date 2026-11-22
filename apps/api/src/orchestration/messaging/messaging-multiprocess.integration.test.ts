import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { withMessagingContext } from './context.js';
import { submitInvestigation } from '../../investigation/gateway.js';
import { promisify } from 'node:util';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { dispatchOnce } from './dispatcher.js';
import { receiveMessage } from './inbox.js';
import { createMessagingTelemetry } from './telemetry.js';
import { ingestSyntheticCatalog } from '../../documents/ingestion.js';
import { createHarness, closeHarness, readerPrincipal, requireEnv, roleUrl, sleep, spawnMessagingWorker, startInvestigation, startStubEgress, wireOf, SPIFFE,
  NORTH, QUESTION, type Harness, type StubEgress } from './testing/support.js';

// P5 and P8 with real OS processes and SIGKILL at labelled points, each process connected as its own workload role, checked in PostgreSQL.

const execFileAsync = promisify(execFile);
let h: Harness;
let stubs: Record<string, StubEgress>;
const telemetry = createMessagingTelemetry();
const count = async (sql: string, values: unknown[] = []) => Number((await h.adminPool.query<{ n: string }>(sql, values)).rows[0].n);

beforeAll(async () => {
  h = await createHarness();
  const ingestPool = new Pool({ connectionString: process.env.TEST_DOCUMENT_INGEST_URL, max: 2 });
  try { await ingestSyntheticCatalog(ingestPool); } finally { await ingestPool.end(); }
  stubs = {
    orchestrator: await startStubEgress('orchestrator', h.pools),
    triage: await startStubEgress('triage', h.pools),
  };
});
afterAll(async () => {
  for (const s of Object.values(stubs ?? {})) await s.close();
  if (h) await closeHarness(h);
});
beforeEach(async () => {
  await h.adminPool.query(`UPDATE aegis.agent_outbox SET status = 'dead', dead_at = clock_timestamp(), dead_reason = 'retry_exhausted',
    lease_instance = NULL, lease_expires_at = NULL WHERE status IN ('pending', 'leased')`);
});
const dispatchInProcess = (agent: 'orchestrator' | 'triage', egressUrl: string) => dispatchOnce({ pool: h.pools[agent], agentId: agent,
  instance: `${agent}-mp`, egressUrl, leaseSeconds: 30, batchSize: 8, deliveryTimeoutMs: 5000, telemetry });

describe('receiver crashes (triage role)', () => {
  it('a receiver killed before its inbox transaction commits leaves nothing; redelivery processes the message once', async () => {
    const started = await startInvestigation(h, { tenantId: NORTH, question: QUESTION });
    const body = await wireOf(h, started.requestMessageId);
    const child = spawnMessagingWorker({ op: 'receive', dbUrl: roleUrl('triage'), pauseBeforeCommit: 'receive:accepted',
      receive: { receiver: 'triage', peerSpiffeId: SPIFFE.orchestrator, messageId: started.requestMessageId, body } });
    await child.waitForEvent('PAUSED');
    child.kill();
    await child.exited();
    expect(await count('SELECT count(*)::text AS n FROM aegis.agent_inbox WHERE message_id = $1', [started.requestMessageId])).toBe(0);
    expect(await count(`SELECT count(*)::text AS n FROM aegis.agent_grants WHERE execution_id = $1 AND status = 'consumed'`, [started.executionId])).toBe(0);
    expect(await count(`SELECT count(*)::text AS n FROM aegis.agent_outbox WHERE execution_id = $1 AND sender_agent = 'triage'`, [started.executionId])).toBe(0);
    const redelivered = await receiveMessage(h.pools.triage, {}, { receiver: 'triage', peerSpiffeId: SPIFFE.orchestrator, messageId: started.requestMessageId, body });
    expect(redelivered).toMatchObject({ httpStatus: 200, status: 'processed' });
    expect(await count(`SELECT count(*)::text AS n FROM aegis.agent_outbox WHERE execution_id = $1 AND sender_agent = 'triage'`, [started.executionId])).toBe(1);
  });

  it('a receiver killed after its inbox transaction commits, before acknowledging, returns the stored outcome on redelivery', async () => {
    const started = await startInvestigation(h, { tenantId: NORTH, question: QUESTION });
    const body = await wireOf(h, started.requestMessageId);
    const child = spawnMessagingWorker({ op: 'receive', dbUrl: roleUrl('triage'), pauseAfterCommit: true,
      receive: { receiver: 'triage', peerSpiffeId: SPIFFE.orchestrator, messageId: started.requestMessageId, body } });
    await child.waitForEvent('COMMITTED');
    child.kill();
    await child.exited();
    expect(await count(`SELECT count(*)::text AS n FROM aegis.agent_inbox WHERE message_id = $1 AND outcome = 'processed'`, [started.requestMessageId])).toBe(1);
    const again = await receiveMessage(h.pools.triage, {}, { receiver: 'triage', peerSpiffeId: SPIFFE.orchestrator, messageId: started.requestMessageId, body });
    expect(again).toMatchObject({ httpStatus: 200, status: 'duplicate' });
    expect(await count(`SELECT count(*)::text AS n FROM aegis.agent_outbox WHERE execution_id = $1 AND sender_agent = 'triage'`, [started.executionId])).toBe(1);
  });

  it('two receiver processes deliver the same message at the same instant: one processes it, the other is a duplicate', async () => {
    const started = await startInvestigation(h, { tenantId: NORTH, question: QUESTION });
    const body = await wireOf(h, started.requestMessageId);
    const startAt = Date.now() + 3000;
    const children = [0, 1].map(() => spawnMessagingWorker({ op: 'receive', dbUrl: roleUrl('triage'), startAt,
      receive: { receiver: 'triage', peerSpiffeId: SPIFFE.orchestrator, messageId: started.requestMessageId, body } }));
    const statuses = (await Promise.all(children.map(async (c) => (await c.exited()).events.find((e) => e.event === 'RESULT')?.result)))
      .map((r) => (r as { status: string } | undefined)?.status).sort();
    expect(statuses).toEqual(['duplicate', 'processed']);
    expect(await count(`SELECT count(*)::text AS n FROM aegis.agent_outbox WHERE execution_id = $1 AND sender_agent = 'triage'`, [started.executionId])).toBe(1);
  });
});

describe('dispatcher crashes (orchestrator role)', () => {
  it('a dispatcher killed before delivery leaves its message leased; lease recovery delivers it once with a new fencing token', async () => {
    const started = await startInvestigation(h, { tenantId: NORTH, question: QUESTION });
    const child = spawnMessagingWorker({ op: 'dispatch', dbUrl: roleUrl('orchestrator'), pauseBeforeDeliver: true,
      dispatch: { agentId: 'orchestrator', egressUrl: stubs.orchestrator.url, leaseSeconds: 1, batchSize: 8 } });
    await child.waitForEvent('PAUSED');
    child.kill();
    await child.exited();
    const leased = await h.adminPool.query<{ status: string; fencing_token: string }>(
      'SELECT status, fencing_token::text AS fencing_token FROM aegis.agent_outbox WHERE message_id = $1', [started.requestMessageId]);
    expect(leased.rows[0]).toEqual({ status: 'leased', fencing_token: '1' });
    await sleep(1200);
    const recovered = await dispatchInProcess('orchestrator', stubs.orchestrator.url);
    expect(recovered.recovered).toBeGreaterThanOrEqual(1);
    const row = await h.adminPool.query<{ status: string; fencing_token: string }>(
      'SELECT status, fencing_token::text AS fencing_token FROM aegis.agent_outbox WHERE message_id = $1', [started.requestMessageId]);
    expect(row.rows[0]).toEqual({ status: 'delivered', fencing_token: '2' });
    expect(stubs.orchestrator.deliveries.filter((d) => d.messageId === started.requestMessageId)).toHaveLength(1);
  });

  it('a dispatcher killed after delivery but before acknowledging: the redelivery is suppressed by the inbox and acknowledged', async () => {
    const started = await startInvestigation(h, { tenantId: NORTH, question: QUESTION });
    const child = spawnMessagingWorker({ op: 'dispatch', dbUrl: roleUrl('orchestrator'), pauseBeforeAck: true,
      dispatch: { agentId: 'orchestrator', egressUrl: stubs.orchestrator.url, leaseSeconds: 1, batchSize: 8 } });
    await child.waitForEvent('PAUSED');
    child.kill();
    await child.exited();
    expect(await count(`SELECT count(*)::text AS n FROM aegis.agent_inbox WHERE message_id = $1 AND outcome = 'processed'`, [started.requestMessageId])).toBe(1);
    await sleep(1200);
    await dispatchInProcess('orchestrator', stubs.orchestrator.url);
    const row = await h.adminPool.query<{ status: string }>('SELECT status FROM aegis.agent_outbox WHERE message_id = $1', [started.requestMessageId]);
    expect(row.rows[0].status).toBe('delivered');
    expect(stubs.orchestrator.deliveries.filter((d) => d.messageId === started.requestMessageId).map((d) => d.status)).toEqual([200, 200]);
    expect(await count('SELECT count(*)::text AS n FROM aegis.agent_inbox WHERE message_id = $1', [started.requestMessageId])).toBe(1);
    expect(await count(`SELECT count(*)::text AS n FROM aegis.agent_message_events WHERE message_id = $1 AND event_type = 'inbox_duplicate'`, [started.requestMessageId])).toBe(1);
  });

  it('three dispatcher processes running at once deliver six messages, each exactly once', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 6; i += 1) ids.push((await startInvestigation(h, { tenantId: NORTH, question: QUESTION })).requestMessageId);
    const children = [0, 1, 2].map(() => spawnMessagingWorker({ op: 'dispatch', dbUrl: roleUrl('orchestrator'),
      dispatch: { agentId: 'orchestrator', egressUrl: stubs.orchestrator.url, leaseSeconds: 30, batchSize: 2 } }));
    const results = await Promise.all(children.map(async (c) => (await c.exited()).events.find((e) => e.event === 'RESULT')?.summary as { claimed: number }));
    expect(results.reduce((sum, s) => sum + s.claimed, 0)).toBe(6);
    for (const id of ids) expect(stubs.orchestrator.deliveries.filter((d) => d.messageId === id)).toHaveLength(1);
  });
});

describe('intake crashes (orchestrator role)', () => {
  it('an orchestrator killed before its start commits leaves the investigation submitted; the next intake starts it once', async () => {
    const submitted = await startSubmitted();
    const child = spawnMessagingWorker({ op: 'intake', dbUrl: roleUrl('orchestrator'), pauseBeforeCommit: 'release:accepted',
      intake: { tenantId: NORTH, executionId: submitted, spiffeId: SPIFFE.orchestrator } });
    await child.waitForEvent('PAUSED');
    child.kill();
    await child.exited();
    const state = await h.adminPool.query<{ workflow_stage: string; lease_agent_id: string | null }>(
      'SELECT workflow_stage, lease_agent_id FROM aegis.agent_executions WHERE execution_id = $1', [submitted]);
    expect(state.rows[0]).toEqual({ workflow_stage: 'submitted', lease_agent_id: null });
    expect(await count('SELECT count(*)::text AS n FROM aegis.agent_outbox WHERE execution_id = $1', [submitted])).toBe(0);
    const again = spawnMessagingWorker({ op: 'intake', dbUrl: roleUrl('orchestrator'), intake: { tenantId: NORTH, executionId: submitted, spiffeId: SPIFFE.orchestrator } });
    expect((await again.exited()).events.find((e) => e.event === 'RESULT')?.outcome).toBe('started');
    expect(await count('SELECT count(*)::text AS n FROM aegis.agent_outbox WHERE execution_id = $1', [submitted])).toBe(1);
  });

  it('an orchestrator killed after its start commits: the triage request is durable and is then delivered', async () => {
    const submitted = await startSubmitted();
    const child = spawnMessagingWorker({ op: 'intake', dbUrl: roleUrl('orchestrator'), pauseAfterCommit: true,
      intake: { tenantId: NORTH, executionId: submitted, spiffeId: SPIFFE.orchestrator } });
    await child.waitForEvent('COMMITTED');
    child.kill();
    await child.exited();
    const stage = await h.adminPool.query<{ workflow_stage: string }>('SELECT workflow_stage FROM aegis.agent_executions WHERE execution_id = $1', [submitted]);
    expect(stage.rows[0].workflow_stage).toBe('triage_requested');
    await dispatchInProcess('orchestrator', stubs.orchestrator.url);
    expect(await count(`SELECT count(*)::text AS n FROM aegis.agent_outbox WHERE execution_id = $1 AND status = 'delivered'`, [submitted])).toBe(1);
  });
});

describe('database restart', () => {
  const container = process.env.P5_TEST_CONTAINER;
  const run = container ? it : it.skip;
  run('a message pending across a database restart is still pending afterwards and is delivered once the database is back', async () => {
    const started = await startInvestigation(h, { tenantId: NORTH, question: QUESTION });
    await execFileAsync('docker', ['restart', '-t', '5', container!]);
    const admin = new Pool({ connectionString: requireEnv().adminUrl, max: 1, connectionTimeoutMillis: 30000 });
    for (let attempt = 0; attempt < 60; attempt += 1) {
      try { await admin.query('SELECT 1'); break; } catch { await sleep(1000); }
    }
    await admin.end();
    const row = await h.adminPool.query<{ status: string }>('SELECT status FROM aegis.agent_outbox WHERE message_id = $1', [started.requestMessageId]);
    expect(row.rows[0].status).toBe('pending');
    await dispatchInProcess('orchestrator', stubs.orchestrator.url);
    expect(stubs.orchestrator.deliveries.filter((d) => d.messageId === started.requestMessageId)).toHaveLength(1);
  }, 120000);
});

async function startSubmitted(): Promise<string> {
  await h.adminPool.query(`INSERT INTO aegis.memberships (issuer, subject, tenant_id, role) VALUES ('test-issuer', 'intake-user', $1, 'reader') ON CONFLICT DO NOTHING`, [NORTH]);
  const submitted = await submitInvestigation((t, op) => withMessagingContext(h.pools.gateway, { tenantId: t }, op as never) as never,
    readerPrincipal('intake-user'), { tenantId: NORTH, idempotencyKey: randomUUID(), question: QUESTION });
  return submitted.executionId;
}

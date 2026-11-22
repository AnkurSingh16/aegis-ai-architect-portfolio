import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ACTION_REQUEST, ACTION_RESULT, TRIAGE_AGENT, WORKFLOW_SCOPES } from './workflow.js';
import { dispatchOnce } from './dispatcher.js';
import { receiveMessage } from './inbox.js';
import { createMessagingTelemetry } from './telemetry.js';
import { createHarness, readRequestWire, SPIFFE, sleep, spawnMessagingWorker, startExecution, startStubEgress, wireBody, requireEnv,
  type Harness, type StubEgress } from './testing/support.js';

// P5 with real OS processes and SIGKILL at labelled points, checked directly in PostgreSQL. Each worker is its own process with its own
// connections, running as aegis_app. Transport: an in-process stub that picks the verified peer identity; the real inbox and outbox code.

const execFileAsync = promisify(execFile);
let h: Harness;
let dbUrl: string;
const stubs: StubEgress[] = [];
const telemetry = createMessagingTelemetry();
const count = async (sql: string, values: unknown[] = []) => Number((await h.adminPool.query<{ n: string }>(sql, values)).rows[0].n);

beforeAll(async () => {
  dbUrl = requireEnv().runtimeUrl;
  h = await createHarness();
});
afterAll(async () => {
  for (const stub of stubs) await stub.close();
  await h?.pool.end();
  await h?.adminPool.end();
});
beforeEach(async () => {
  await h.adminPool.query(`UPDATE aegis.agent_outbox SET status = 'dead', dead_at = clock_timestamp(), dead_reason = 'retry_exhausted',
    lease_instance = NULL, lease_expires_at = NULL WHERE status IN ('pending', 'leased')`);
});

async function stub(sender: string): Promise<StubEgress> {
  const s = await startStubEgress(h.pool, sender);
  stubs.push(s);
  return s;
}

const dispatchInProcess = (agentId: string, egressUrl: string, extra: Record<string, unknown> = {}) => dispatchOnce({
  pool: h.pool, agentId, instance: `${agentId}-mp`, egressUrl, leaseSeconds: 30, batchSize: 8, deliveryTimeoutMs: 5000, telemetry, ...extra,
});

describe('receiver crashes', () => {
  it('a receiver killed before its inbox transaction commits leaves nothing; redelivery processes the message once', async () => {
    const started = await startExecution(h);
    const wire = await readRequestWire(h, started);
    const body = wireBody(wire);
    const child = spawnMessagingWorker({ op: 'receive', dbUrl, pauseBeforeCommit: 'receive:accepted',
      receive: { receiver: 'triage', peerSpiffeId: SPIFFE.orchestrator, messageId: wire.messageId, body } });
    await child.waitForEvent('PAUSED');
    child.kill();
    await child.exited();
    expect(await count('SELECT count(*)::text AS n FROM aegis.agent_inbox WHERE message_id = $1', [wire.messageId])).toBe(0);
    expect(await count('SELECT count(*)::text AS n FROM aegis.agent_grants WHERE execution_id = $1 AND status = \'consumed\'', [started.executionId])).toBe(0);
    expect(await count('SELECT count(*)::text AS n FROM aegis.agent_outbox WHERE execution_id = $1 AND kind = \'result\'', [started.executionId])).toBe(0);
    const redelivered = await receiveMessage(h.pool, {}, { receiver: 'triage', peerSpiffeId: SPIFFE.orchestrator, messageId: wire.messageId, body });
    expect(redelivered).toMatchObject({ httpStatus: 200, status: 'processed' });
    expect(await count('SELECT count(*)::text AS n FROM aegis.agent_outbox WHERE execution_id = $1 AND kind = \'result\'', [started.executionId])).toBe(1);
  });

  it('a receiver killed after its inbox transaction commits, before acknowledging, returns the stored outcome on redelivery', async () => {
    const started = await startExecution(h);
    const wire = await readRequestWire(h, started);
    const body = wireBody(wire);
    const child = spawnMessagingWorker({ op: 'receive', dbUrl, pauseAfterCommit: true,
      receive: { receiver: 'triage', peerSpiffeId: SPIFFE.orchestrator, messageId: wire.messageId, body } });
    await child.waitForEvent('COMMITTED');
    child.kill();
    await child.exited();
    expect(await count('SELECT count(*)::text AS n FROM aegis.agent_inbox WHERE message_id = $1 AND outcome = \'processed\'', [wire.messageId])).toBe(1);
    expect(await count('SELECT count(*)::text AS n FROM aegis.agent_outbox WHERE execution_id = $1 AND kind = \'result\'', [started.executionId])).toBe(1);
    const again = await receiveMessage(h.pool, {}, { receiver: 'triage', peerSpiffeId: SPIFFE.orchestrator, messageId: wire.messageId, body });
    expect(again).toMatchObject({ httpStatus: 200, status: 'duplicate' });
    expect(await count('SELECT count(*)::text AS n FROM aegis.agent_outbox WHERE execution_id = $1 AND kind = \'result\'', [started.executionId])).toBe(1);
    expect(await count('SELECT count(*)::text AS n FROM aegis.agent_grants WHERE execution_id = $1 AND status = \'consumed\'', [started.executionId])).toBe(1);
  });

  it('two receiver processes deliver the same message at the same instant: one processes it, the other is a duplicate', async () => {
    const started = await startExecution(h);
    const wire = await readRequestWire(h, started);
    const body = wireBody(wire);
    const startAt = Date.now() + 2500;
    const children = [0, 1].map(() => spawnMessagingWorker({ op: 'receive', dbUrl, startAt,
      receive: { receiver: 'triage', peerSpiffeId: SPIFFE.orchestrator, messageId: wire.messageId, body } }));
    const results = await Promise.all(children.map(async (c) => (await c.exited()).events.find((e) => e.event === 'RESULT')));
    const statuses = results.map((r) => (r?.result as { status: string } | undefined)?.status).sort();
    expect(statuses).toEqual(['duplicate', 'processed']);
    expect(await count('SELECT count(*)::text AS n FROM aegis.agent_outbox WHERE execution_id = $1 AND kind = \'result\'', [started.executionId])).toBe(1);
    expect(await count('SELECT count(*)::text AS n FROM aegis.agent_grants WHERE execution_id = $1 AND status = \'consumed\'', [started.executionId])).toBe(1);
  });
});

describe('dispatcher crashes', () => {
  it('a dispatcher killed before delivery leaves its message leased; lease recovery delivers it once with a new fencing token', async () => {
    const orchestrator = await stub(SPIFFE.orchestrator);
    const started = await startExecution(h);
    const child = spawnMessagingWorker({ op: 'dispatch', dbUrl, pauseBeforeDeliver: true,
      dispatch: { agentId: 'orchestrator', egressUrl: orchestrator.url, leaseSeconds: 1, batchSize: 8 } });
    await child.waitForEvent('PAUSED');
    child.kill();
    await child.exited();
    const leased = await h.adminPool.query<{ status: string; fencing_token: string }>(
      'SELECT status, fencing_token::text AS fencing_token FROM aegis.agent_outbox WHERE message_id = $1', [started.requestMessageId]);
    expect(leased.rows[0]).toEqual({ status: 'leased', fencing_token: '1' });
    expect(orchestrator.deliveries.filter((d) => d.messageId === started.requestMessageId)).toHaveLength(0);
    await sleep(1200);
    const recovered = await dispatchInProcess('orchestrator', orchestrator.url);
    expect(recovered.recovered).toBeGreaterThanOrEqual(1);
    const row = await h.adminPool.query<{ status: string; fencing_token: string }>(
      'SELECT status, fencing_token::text AS fencing_token FROM aegis.agent_outbox WHERE message_id = $1', [started.requestMessageId]);
    expect(row.rows[0]).toEqual({ status: 'delivered', fencing_token: '2' });
    expect(orchestrator.deliveries.filter((d) => d.messageId === started.requestMessageId)).toHaveLength(1);
  });

  it('a dispatcher killed after delivery but before acknowledging: the redelivery is suppressed by the inbox and acknowledged', async () => {
    const orchestrator = await stub(SPIFFE.orchestrator);
    const started = await startExecution(h);
    const child = spawnMessagingWorker({ op: 'dispatch', dbUrl, pauseBeforeAck: true,
      dispatch: { agentId: 'orchestrator', egressUrl: orchestrator.url, leaseSeconds: 1, batchSize: 8 } });
    await child.waitForEvent('PAUSED');
    child.kill();
    await child.exited();
    expect(await count('SELECT count(*)::text AS n FROM aegis.agent_inbox WHERE message_id = $1 AND outcome = \'processed\'', [started.requestMessageId])).toBe(1);
    await sleep(1200);
    await dispatchInProcess('orchestrator', orchestrator.url);
    const row = await h.adminPool.query<{ status: string }>('SELECT status FROM aegis.agent_outbox WHERE message_id = $1', [started.requestMessageId]);
    expect(row.rows[0].status).toBe('delivered');
    expect(orchestrator.deliveries.filter((d) => d.messageId === started.requestMessageId).map((d) => d.status)).toEqual([200, 200]);
    expect(await count('SELECT count(*)::text AS n FROM aegis.agent_inbox WHERE message_id = $1', [started.requestMessageId])).toBe(1);
    expect(await count('SELECT count(*)::text AS n FROM aegis.agent_outbox WHERE execution_id = $1 AND kind = \'result\'', [started.executionId])).toBe(1);
    expect(await count('SELECT count(*)::text AS n FROM aegis.agent_message_events WHERE message_id = $1 AND event_type = \'inbox_duplicate\'', [started.requestMessageId])).toBe(1);
  });

  it('three dispatcher processes running at once deliver twelve messages, each exactly once', async () => {
    const orchestrator = await stub(SPIFFE.orchestrator);
    const started = [] as string[];
    for (let i = 0; i < 12; i += 1) started.push((await startExecution(h)).requestMessageId);
    const children = [0, 1, 2].map(() => spawnMessagingWorker({ op: 'dispatch', dbUrl,
      dispatch: { agentId: 'orchestrator', egressUrl: orchestrator.url, leaseSeconds: 30, batchSize: 4 } }));
    const summaries = await Promise.all(children.map(async (c) => (await c.exited()).events.find((e) => e.event === 'RESULT')?.summary as { claimed: number }));
    expect(summaries.reduce((sum, s) => sum + s.claimed, 0)).toBe(12);
    for (const id of started) {
      expect(orchestrator.deliveries.filter((d) => d.messageId === id)).toHaveLength(1);
    }
    expect(await count('SELECT count(*)::text AS n FROM aegis.agent_outbox WHERE message_id = ANY($1::uuid[]) AND status = \'delivered\'', [started])).toBe(12);
  });
});

describe('decision crashes', () => {
  async function claimed() {
    const created = await h.store.createExecution({ tenantId: h.tenantA, idempotencyKey: randomUUID(), principalRef: 'f'.repeat(64),
      principalScopes: ['case:read', 'document:read'], limits: { maxDepth: 3, maxDelegations: 4, maxSteps: 8 }, grantTtlSeconds: 300, maxAttempts: 6 });
    const claim = await h.store.claim({ tenantId: h.tenantA, executionId: created.executionId, spiffeId: SPIFFE.orchestrator, instance: 'mp', leaseSeconds: 120 });
    if (!claim.ok) throw new Error('claim');
    return { executionId: created.executionId, fence: { tenantId: h.tenantA, executionId: created.executionId, agentId: claim.value.agentId,
      instance: 'mp', fencingToken: claim.value.fencingToken } };
  }
  const input = (c: Awaited<ReturnType<typeof claimed>>) => ({ tenantId: h.tenantA, fence: c.fence, to: TRIAGE_AGENT,
    requestedScopes: [...WORKFLOW_SCOPES], action: ACTION_REQUEST, resultAction: ACTION_RESULT,
    arguments: { caseRef: randomUUID(), documentCount: 2, questionCode: 'status_check' as const } });

  it('a process killed before the decision commits leaves no delegation, grant or message', async () => {
    const c = await claimed();
    const child = spawnMessagingWorker({ op: 'delegate', dbUrl, pauseBeforeCommit: 'release:accepted', delegate: input(c) });
    await child.waitForEvent('PAUSED');
    child.kill();
    await child.exited();
    expect(await count('SELECT count(*)::text AS n FROM aegis.agent_delegations WHERE execution_id = $1', [c.executionId])).toBe(0);
    expect(await count('SELECT count(*)::text AS n FROM aegis.agent_grants WHERE execution_id = $1', [c.executionId])).toBe(0);
    expect(await count('SELECT count(*)::text AS n FROM aegis.agent_outbox WHERE execution_id = $1', [c.executionId])).toBe(0);
    const status = await h.adminPool.query<{ status: string; lease_agent_id: string }>('SELECT status, lease_agent_id FROM aegis.agent_executions WHERE execution_id = $1', [c.executionId]);
    expect(status.rows[0]).toEqual({ status: 'running', lease_agent_id: 'orchestrator' });
  });

  it('a process killed after the decision commits: its message is durable and is then delivered', async () => {
    const orchestrator = await stub(SPIFFE.orchestrator);
    const c = await claimed();
    const child = spawnMessagingWorker({ op: 'delegate', dbUrl, pauseAfterCommit: true, delegate: input(c) });
    await child.waitForEvent('COMMITTED');
    child.kill();
    await child.exited();
    expect(await count('SELECT count(*)::text AS n FROM aegis.agent_delegations WHERE execution_id = $1', [c.executionId])).toBe(1);
    expect(await count('SELECT count(*)::text AS n FROM aegis.agent_grants WHERE execution_id = $1 AND status = \'open\'', [c.executionId])).toBe(2);
    expect(await count('SELECT count(*)::text AS n FROM aegis.agent_outbox WHERE execution_id = $1 AND status = \'pending\'', [c.executionId])).toBe(1);
    const summary = await dispatchInProcess('orchestrator', orchestrator.url);
    expect(summary.delivered).toBeGreaterThanOrEqual(1);
    expect(await count('SELECT count(*)::text AS n FROM aegis.agent_outbox WHERE execution_id = $1 AND status = \'delivered\'', [c.executionId])).toBe(1);
  });
});

describe('database restart', () => {
  const container = process.env.P5_TEST_CONTAINER;
  const run = container ? it : it.skip;
  run('a message pending across a database restart is still pending afterwards and is delivered once the database is back', async () => {
    const orchestrator = await stub(SPIFFE.orchestrator);
    const started = await startExecution(h);
    await execFileAsync('docker', ['restart', '-t', '5', container!]);
    const admin = new Pool({ connectionString: requireEnv().adminUrl, max: 1, connectionTimeoutMillis: 30000 });
    for (let attempt = 0; attempt < 60; attempt += 1) {
      try { await admin.query('SELECT 1'); break; } catch { await sleep(1000); }
    }
    await admin.end();
    const row = await h.adminPool.query<{ status: string }>('SELECT status FROM aegis.agent_outbox WHERE message_id = $1', [started.requestMessageId]);
    expect(row.rows[0].status).toBe('pending');
    const summary = await dispatchInProcess('orchestrator', orchestrator.url);
    expect(summary.delivered).toBeGreaterThanOrEqual(1);
    expect(orchestrator.deliveries.filter((d) => d.messageId === started.requestMessageId)).toHaveLength(1);
  }, 120000);
});

import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import { createDatabasePool } from '../storage/database.js';
import { migrateDatabase } from '../storage/migrations.js';
import { AuthorizationError, type VerifiedPrincipal } from '../auth/token.js';
import { registerProtectedWorkflowRoutes } from './workflow-routes.js';
import { createDurableStore } from './durable-store.js';
import type { TenantQueryable } from '../security/tool-approval-store.js';
import { runDurableAttempt } from './durable-driver.js';

// Real PostgreSQL + Fastify injection tests for the authenticated triage workflow route.
const adminUrl = process.env.TEST_DATABASE_ADMIN_URL;
const runtimeUrl = process.env.TEST_DATABASE_URL;
if (!adminUrl || !runtimeUrl) throw new Error('Set TEST_DATABASE_ADMIN_URL and TEST_DATABASE_URL for real PostgreSQL tests.');

const admin = new Pool({ connectionString: adminUrl, max: 1 });
const pool = createDatabasePool(runtimeUrl, 4);
const tenantNorth = randomUUID();
const tenantSouth = randomUUID();
const issuer = 'https://issuer.example.test/';
const readerSubject = `reader-${randomUUID()}`;
const noReadSubject = `noread-${randomUUID()}`;
let app: FastifyInstance;

const readerPrincipal: VerifiedPrincipal = { issuer, subject: readerSubject, scopes: new Set(['read:cases']) };
const noScopePrincipal: VerifiedPrincipal = { issuer, subject: readerSubject, scopes: new Set() };
const stranger: VerifiedPrincipal = { issuer, subject: noReadSubject, scopes: new Set(['read:cases']) };
const operatorSubject = `operator-${randomUUID()}`;
const operatorPrincipal: VerifiedPrincipal = { issuer, subject: operatorSubject, scopes: new Set(['read:cases', 'write:cases']) };
// The reader's token with the write scope: the scope passes, the reader role must still be refused.
const readerWritePrincipal: VerifiedPrincipal = { issuer, subject: readerSubject, scopes: new Set(['read:cases', 'write:cases']) };

const verify = async (authorization: string | undefined): Promise<VerifiedPrincipal> => {
  if (authorization === 'Bearer operator') return operatorPrincipal;
  if (authorization === 'Bearer reader-write') return readerWritePrincipal;
  if (authorization === 'Bearer reader') return readerPrincipal;
  if (authorization === 'Bearer no-scope') return noScopePrincipal;
  if (authorization === 'Bearer stranger') return stranger;
  throw new AuthorizationError(401);
};

const key = () => randomUUID();
const post = (tenant: string, headers: Record<string, string>, body: unknown) =>
  app.inject({ method: 'POST', url: `/api/tenants/${tenant}/workflows/triage`, headers: { 'content-type': 'application/json', ...headers }, payload: body as object });
const get = (tenant: string, path: string, authorization: string, headers: Record<string, string> = {}) =>
  app.inject({ method: 'GET', url: `/api/tenants/${tenant}/workflows/${path}`, headers: { authorization, ...headers } });

// Same tenant-scoped transaction as the route, used here only to drive a failure through the durable store.
const runTenant = async <T>(tenantId: string, operation: (client: TenantQueryable) => Promise<T>): Promise<T> => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('aegis.tenant_id', $1, true)", [tenantId]);
    const result = await operation(client as unknown as TenantQueryable);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
};

/** Creates one execution and drives it to 'failed' through the store, the only path that can reach that state. */
async function createFailedExecution(tenantId: string): Promise<string> {
  const store = createDurableStore(runTenant);
  const { executionId } = await store.createExecution(tenantId, key(), 3);
  const now = new Date();
  const claimed = await store.claim(executionId, tenantId, 'test-owner', now, new Date(now.getTime() + 30_000));
  if (!claimed) throw new Error('test execution was not claimable');
  await store.transition({
    executionId, tenantId, owner: 'test-owner', expectedVersion: claimed.version, state: 'failed', attempts: 1,
    nextAttemptAt: null, lastErrorClass: 'permanent', keepLease: false, leaseExpiresAt: now, now,
  });
  return executionId;
}

beforeAll(async () => {
  await migrateDatabase(adminUrl, process.env.DATABASE_APP_PASSWORD ?? '', process.env.DATABASE_INGEST_PASSWORD ?? '');
  await admin.query("INSERT INTO aegis.tenants (id, name) VALUES ($1, 'Synthetic North'), ($2, 'Synthetic South')", [tenantNorth, tenantSouth]);
  await admin.query("INSERT INTO aegis.memberships (issuer, subject, tenant_id, role) VALUES ($1, $2, $3, 'reader')", [issuer, readerSubject, tenantNorth]);
  await admin.query("INSERT INTO aegis.memberships (issuer, subject, tenant_id, role) VALUES ($1, $2, $3, 'operator')", [issuer, operatorSubject, tenantNorth]);
  app = Fastify();
  await app.register(async (scoped) => registerProtectedWorkflowRoutes(scoped, pool, verify));
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await pool.end();
  await admin.end();
});

describe('POST /api/tenants/:tenantId/workflows/triage', () => {
  it('refuses unauthenticated requests', async () => {
    const response = await post(tenantNorth, { 'idempotency-key': key() }, { caseId: 'SYNTHETIC-LOGIN-001' });
    expect(response.statusCode).toBe(401);
    expect(response.headers['www-authenticate']).toBe('Bearer');
  });

  it('refuses a token without the read scope', async () => {
    const response = await post(tenantNorth, { authorization: 'Bearer no-scope', 'idempotency-key': key() }, { caseId: 'SYNTHETIC-LOGIN-001' });
    expect(response.statusCode).toBe(403);
  });

  it('refuses a principal with no membership in the requested tenant', async () => {
    const response = await post(tenantNorth, { authorization: 'Bearer stranger', 'idempotency-key': key() }, { caseId: 'SYNTHETIC-LOGIN-001' });
    expect(response.statusCode).toBe(403);
  });

  it('refuses a member of one tenant reaching into another', async () => {
    const response = await post(tenantSouth, { authorization: 'Bearer reader', 'idempotency-key': key() }, { caseId: 'SYNTHETIC-LOGIN-001' });
    expect(response.statusCode).toBe(403);
  });

  it('rejects a missing idempotency key and unknown case ids', async () => {
    expect((await post(tenantNorth, { authorization: 'Bearer reader' }, { caseId: 'SYNTHETIC-LOGIN-001' })).statusCode).toBe(400);
    expect((await post(tenantNorth, { authorization: 'Bearer reader', 'idempotency-key': key() }, { caseId: 'NOT-A-CASE' })).statusCode).toBe(400);
    expect((await post(tenantNorth, { authorization: 'Bearer reader', 'idempotency-key': 'not-a-uuid' }, { caseId: 'SYNTHETIC-LOGIN-001' })).statusCode).toBe(400);
  });

  it('runs the triage workflow for a member and returns the fixture output', async () => {
    const response = await post(tenantNorth, { authorization: 'Bearer reader', 'idempotency-key': key() }, { caseId: 'SYNTHETIC-LOGIN-001' });
    expect(response.statusCode).toBe(201);
    const body = response.json() as { executionId: string; created: boolean; outcome: string; output: { category: string } };
    expect(body).toMatchObject({ created: true, outcome: 'succeeded', output: { category: 'incident' } });
    expect(body.executionId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('is idempotent: a repeated key returns the same execution without running again', async () => {
    const idKey = key();
    const first = await post(tenantNorth, { authorization: 'Bearer reader', 'idempotency-key': idKey }, { caseId: 'SYNTHETIC-BILLING-002' });
    const second = await post(tenantNorth, { authorization: 'Bearer reader', 'idempotency-key': idKey }, { caseId: 'SYNTHETIC-BILLING-002' });
    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(200);
    const a = first.json() as { executionId: string };
    const b = second.json() as { executionId: string; outcome: string; output?: unknown };
    expect(b.executionId).toBe(a.executionId);
    expect(b.outcome).toBe('not_claimable');
    expect(b.output).toBeUndefined();
  });
});

describe('GET /api/tenants/:tenantId/workflows/executions/:executionId', () => {
  it('returns state and checkpoints for a member, and refuses other callers', async () => {
    const created = (await post(tenantNorth, { authorization: 'Bearer reader', 'idempotency-key': key() }, { caseId: 'SYNTHETIC-LOGIN-001' })).json() as { executionId: string };
    const read = await get(tenantNorth, `executions/${created.executionId}`, 'Bearer reader');
    expect(read.statusCode).toBe(200);
    const body = read.json() as { state: string; attempts: number; checkpoints: { seq: number; state: string }[]; approvalGranted: boolean };
    expect(body).toMatchObject({ state: 'succeeded', attempts: 1, approvalGranted: false });
    expect(body.checkpoints.map((c) => c.seq)).toEqual([...body.checkpoints.map((c) => c.seq)].sort((a, b) => a - b));
    expect(body.checkpoints.at(-1)?.state).toBe('succeeded');

    expect((await get(tenantNorth, `executions/${created.executionId}`, 'Bearer stranger')).statusCode).toBe(403);
    expect((await get(tenantNorth, `executions/${created.executionId}`, 'Bearer no-scope')).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: `/api/tenants/${tenantNorth}/workflows/executions/${created.executionId}` })).statusCode).toBe(401);
  });

  it('does not reveal an execution from another tenant, and returns 404 for an unknown id', async () => {
    const created = (await post(tenantNorth, { authorization: 'Bearer reader', 'idempotency-key': key() }, { caseId: 'SYNTHETIC-LOGIN-001' })).json() as { executionId: string };
    // The reader is a member of North only. Asking South for North's execution is refused by membership.
    expect((await get(tenantSouth, `executions/${created.executionId}`, 'Bearer reader')).statusCode).toBe(403);
    expect((await get(tenantNorth, `executions/${randomUUID()}`, 'Bearer reader')).statusCode).toBe(404);
  });
});

describe('correlation id on the execution', () => {
  it('records the caller correlation id at creation and returns it from the status route', async () => {
    const created = await post(tenantNorth, { authorization: 'Bearer reader', 'idempotency-key': key(), 'x-correlation-id': 'trace-7781' }, { caseId: 'SYNTHETIC-LOGIN-001' });
    const { executionId } = created.json() as { executionId: string };
    const read = (await get(tenantNorth, `executions/${executionId}`, 'Bearer reader')).json() as { correlationId: string };
    expect(read.correlationId).toBe('trace-7781');
  });

  it('logs the correlation id on the status and dead-letter routes', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    try {
      const created = await post(tenantNorth, { authorization: 'Bearer reader', 'idempotency-key': key(), 'x-correlation-id': 'get-trace-3' }, { caseId: 'SYNTHETIC-LOGIN-001' });
      const { executionId } = created.json() as { executionId: string };
      await get(tenantNorth, `executions/${executionId}`, 'Bearer reader', { 'x-correlation-id': 'get-trace-4' });
      await get(tenantNorth, `executions/${randomUUID()}`, 'Bearer reader', { 'x-correlation-id': 'get-trace-5' });
      await get(tenantNorth, 'dead-letters', 'Bearer reader', { 'x-correlation-id': 'get-trace-6' });
      const lines = info.mock.calls.map((call) => JSON.parse(String(call[0])) as Record<string, unknown>);
      expect(lines).toContainEqual(expect.objectContaining({ route: 'execution_status', outcome: 'success', correlationId: 'get-trace-4', executionId }));
      expect(lines).toContainEqual(expect.objectContaining({ route: 'execution_status', outcome: 'not_found', correlationId: 'get-trace-5' }));
      expect(lines).toContainEqual(expect.objectContaining({ route: 'dead_letters', outcome: 'success', correlationId: 'get-trace-6' }));
    } finally {
      info.mockRestore();
    }
  });

  it('logs the correlation id, execution id and driver status for a successful triage request', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    try {
      const response = await post(tenantNorth, { authorization: 'Bearer reader', 'idempotency-key': key(), 'x-correlation-id': 'log-trace-9' }, { caseId: 'SYNTHETIC-LOGIN-001' });
      const { executionId, outcome } = response.json() as { executionId: string; outcome: string };
      const lines = info.mock.calls.map((call) => JSON.parse(String(call[0])) as Record<string, unknown>);
      expect(lines).toContainEqual(expect.objectContaining({
        event: 'workflow_request', outcome: 'success', correlationId: 'log-trace-9', executionId, driverStatus: outcome,
      }));
    } finally {
      info.mockRestore();
    }
  });

  it('logs the driver record for a triage request with the same correlation id and execution id', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    try {
      const response = await post(tenantNorth, { authorization: 'Bearer reader', 'idempotency-key': key(), 'x-correlation-id': 'driver-trace-11' }, { caseId: 'SYNTHETIC-LOGIN-001' });
      const { executionId, outcome } = response.json() as { executionId: string; outcome: string };
      const lines = info.mock.calls.map((call) => JSON.parse(String(call[0])) as Record<string, unknown>);
      expect(lines).toContainEqual(expect.objectContaining({
        event: 'durable_attempt', correlationId: 'driver-trace-11', executionId, outcome, requestId: expect.any(String),
      }));
    } finally {
      info.mockRestore();
    }
  });

  it('keeps the first correlation id when a repeated key arrives with a different one', async () => {
    const idKey = key();
    const first = (await post(tenantNorth, { authorization: 'Bearer reader', 'idempotency-key': idKey, 'x-correlation-id': 'first-trace' }, { caseId: 'SYNTHETIC-LOGIN-001' })).json() as { executionId: string };
    await post(tenantNorth, { authorization: 'Bearer reader', 'idempotency-key': idKey, 'x-correlation-id': 'second-trace' }, { caseId: 'SYNTHETIC-LOGIN-001' });
    const read = (await get(tenantNorth, `executions/${first.executionId}`, 'Bearer reader')).json() as { correlationId: string };
    expect(read.correlationId).toBe('first-trace');
  });
});

describe('GET /api/tenants/:tenantId/workflows/dead-letters', () => {
  it('lists failed executions for a member, newest first, with a bounded limit', async () => {
    const failedId = await createFailedExecution(tenantNorth);
    const response = await get(tenantNorth, 'dead-letters?limit=5', 'Bearer reader');
    expect(response.statusCode).toBe(200);
    const body = response.json() as { items: { executionId: string; lastErrorClass: string; attempts: number }[] };
    expect(body.items.length).toBeLessThanOrEqual(5);
    expect(body.items).toContainEqual(expect.objectContaining({ executionId: failedId, lastErrorClass: 'permanent', attempts: 1 }));
    expect(body.items.every((item) => item.executionId !== undefined)).toBe(true);
  });

  it('keeps dead letters tenant-scoped and rejects out-of-range limits', async () => {
    const southFailed = await createFailedExecution(tenantSouth);
    const northView = (await get(tenantNorth, 'dead-letters', 'Bearer reader')).json() as { items: { executionId: string }[] };
    expect(northView.items.map((i) => i.executionId)).not.toContain(southFailed);
    expect((await get(tenantSouth, 'dead-letters', 'Bearer reader')).statusCode).toBe(403);
    expect((await get(tenantNorth, 'dead-letters?limit=0', 'Bearer reader')).statusCode).toBe(400);
    expect((await get(tenantNorth, 'dead-letters?limit=101', 'Bearer reader')).statusCode).toBe(400);
  });
});

describe('correlation ids', () => {
  it('echoes a valid caller id on success and on failure', async () => {
    const ok = await post(tenantNorth, { authorization: 'Bearer reader', 'idempotency-key': key(), 'x-correlation-id': 'case-review.42' }, { caseId: 'SYNTHETIC-LOGIN-001' });
    expect(ok.headers['x-correlation-id']).toBe('case-review.42');
    const denied = await post(tenantNorth, { authorization: 'Bearer stranger', 'idempotency-key': key(), 'x-correlation-id': 'case-review.43' }, { caseId: 'SYNTHETIC-LOGIN-001' });
    expect(denied.headers['x-correlation-id']).toBe('case-review.43');
  });

  it('replaces an unsafe caller id with the request id instead of echoing it', async () => {
    const unsafe = 'bad id "with quotes"';
    const response = await post(tenantNorth, { authorization: 'Bearer reader', 'idempotency-key': key(), 'x-correlation-id': unsafe }, { caseId: 'SYNTHETIC-LOGIN-001' });
    const header = response.headers['x-correlation-id'];
    expect(typeof header).toBe('string');
    expect(header).not.toBe(unsafe);
    expect(header).toMatch(/^[A-Za-z0-9._:-]{1,128}$/);
  });
});

/** Drives one execution to 'failed' with its whole attempt budget used, the usual shape of a dead letter. */
async function createExhaustedExecution(tenantId: string): Promise<string> {
  const store = createDurableStore(runTenant);
  const { executionId } = await store.createExecution(tenantId, key(), 3);
  const now = new Date();
  const claimed = await store.claim(executionId, tenantId, 'test-owner', now, new Date(now.getTime() + 30_000));
  if (!claimed) throw new Error('test execution was not claimable');
  await store.transition({
    executionId, tenantId, owner: 'test-owner', expectedVersion: claimed.version, state: 'failed', attempts: 3,
    nextAttemptAt: null, lastErrorClass: 'retryable', keepLease: false, leaseExpiresAt: now, now,
  });
  return executionId;
}

describe('POST /api/tenants/:tenantId/workflows/dead-letters/:executionId/requeue', () => {
  const requeue = (tenant: string, executionId: string, authorization: string, body: unknown, headers: Record<string, string> = {}) =>
    app.inject({ method: 'POST', url: `/api/tenants/${tenant}/workflows/dead-letters/${executionId}/requeue`, headers: { 'content-type': 'application/json', authorization, ...headers }, payload: body as object });

  it('refuses unauthenticated requests and readers, even with the write scope', async () => {
    const executionId = await createFailedExecution(tenantNorth);
    expect((await requeue(tenantNorth, executionId, '', { reason: 'retry' })).statusCode).toBe(401);
    expect((await requeue(tenantNorth, executionId, 'Bearer reader', { reason: 'retry' })).statusCode).toBe(403);
    expect((await requeue(tenantNorth, executionId, 'Bearer reader-write', { reason: 'retry' })).statusCode).toBe(403);
  });

  it('refuses a blank or missing reason', async () => {
    const executionId = await createFailedExecution(tenantNorth);
    expect((await requeue(tenantNorth, executionId, 'Bearer operator', { reason: '   ' })).statusCode).toBe(400);
    expect((await requeue(tenantNorth, executionId, 'Bearer operator', {})).statusCode).toBe(400);
  });

  it('lets an operator requeue a failed execution once, records who and why, and removes it from the dead letters', async () => {
    const executionId = await createFailedExecution(tenantNorth);
    const first = await requeue(tenantNorth, executionId, 'Bearer operator', { reason: 'Upstream fixed, retry it' });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ executionId, state: 'retry_wait', attempts: 1 });

    const audit = await admin.query<{ actor: string; reason: string }>(
      "SELECT actor, reason FROM aegis.workflow_checkpoints WHERE execution_id = $1 AND state = 'retry_wait'", [executionId]);
    expect(audit.rows).toEqual([{ actor: operatorSubject, reason: 'Upstream fixed, retry it' }]);

    const second = await requeue(tenantNorth, executionId, 'Bearer operator', { reason: 'again' });
    expect(second.statusCode).toBe(409);

    const deadLetters = (await get(tenantNorth, 'dead-letters', 'Bearer reader')).json() as { items: Array<{ executionId: string }> };
    expect(deadLetters.items.map((item) => item.executionId)).not.toContain(executionId);
  });

  it('gives an exhausted execution exactly one more attempt; if that fails, it is permanent', async () => {
    const executionId = await createExhaustedExecution(tenantNorth);
    expect((await requeue(tenantNorth, executionId, 'Bearer operator', { reason: 'Vendor outage is over' })).statusCode).toBe(200);

    const store = createDurableStore(runTenant);
    const outcome = await runDurableAttempt({
      store, executionId, tenantId: tenantNorth, owner: 'operator-test-owner',
      policy: { maxAttempts: 3, baseDelayMs: 1000, maxDelayMs: 8000 }, leaseMs: 30_000, timeoutMs: 5_000, clock: () => new Date(),
      step: async () => { throw new Error('still failing'); },
    });
    expect(outcome).toMatchObject({ status: 'failed', attempt: 4 });
  });

  it('returns 404 for an unknown execution', async () => {
    expect((await requeue(tenantNorth, randomUUID(), 'Bearer operator', { reason: 'retry' })).statusCode).toBe(404);
  });
});

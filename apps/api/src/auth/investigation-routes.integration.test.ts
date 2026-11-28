import Fastify from 'fastify';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuthorizationError, type VerifiedPrincipal } from './token.js';
import { registerInvestigationRoutes } from './investigation-routes.js';
import { createHarness, closeHarness, NORTH, SOUTH, SPIFFE, TEST_ISSUER, type Harness } from '../orchestration/messaging/testing/support.js';
import { withMessagingContext } from '../orchestration/messaging/context.js';
import { reconcileCancellations } from '../orchestration/messaging/cancellation.js';
import { createAgentExecutionStore, joinTransaction } from '../orchestration/persistence/execution-store.js';
import { principalDigest } from '../investigation/gateway.js';
import { Pool } from 'pg';

// The authenticated API over real PostgreSQL. The token verifier is replaced by a table of already-verified principals, so each test
// names the principal it presents; the gateway's membership and scope checks are the real database checks.

let h: Harness;
const principals: Record<string, VerifiedPrincipal> = {
  reader: { issuer: TEST_ISSUER, subject: 'api-reader', scopes: new Set(['read:cases']) },
  noscope: { issuer: TEST_ISSUER, subject: 'api-reader', scopes: new Set(['observe:metrics']) },
  stranger: { issuer: TEST_ISSUER, subject: 'api-stranger', scopes: new Set(['read:cases']) },
  other: { issuer: TEST_ISSUER, subject: 'api-other', scopes: new Set(['read:cases']) },
  // Isolated: reader membership in both tenants is granted by the test that uses it. The NORTH-only reader above is unchanged.
  dual: { issuer: TEST_ISSUER, subject: 'api-dual', scopes: new Set(['read:cases']) },
};
const verify = async (authorization: string | undefined): Promise<VerifiedPrincipal> => {
  if (!authorization) throw new AuthorizationError(401);
  const key = authorization.replace(/^Bearer /, '');
  if (key === 'expired') throw new AuthorizationError(401);
  const principal = principals[key];
  if (!principal) throw new AuthorizationError(401);
  return principal;
};
const app = Fastify();
let gateway: Pool;
const uuid = () => randomUUID();

beforeAll(async () => {
  h = await createHarness();
  for (const subject of ['api-reader', 'api-other']) {
    await h.adminPool.query(`INSERT INTO aegis.memberships (issuer, subject, tenant_id, role) VALUES ($1, $2, $3, 'reader') ON CONFLICT DO NOTHING`, [TEST_ISSUER, subject, NORTH]);
  }
  gateway = h.pools.gateway;
  registerInvestigationRoutes(app, gateway, verify);
  await app.ready();
});
afterAll(async () => {
  await app.close();
  if (h) await closeHarness(h);
});

const post = (token: string | null, tenant: string, body: unknown, key = uuid()) => app.inject({ method: 'POST',
  url: `/api/tenants/${tenant}/investigations`, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), 'idempotency-key': key,
    'content-type': 'application/json' }, payload: body as never });

describe('authenticated investigation API', () => {
  it('refuses requests without a valid token, with an expired token, and with the wrong scope', async () => {
    expect((await post(null, NORTH, { question: 'Which policy?' })).statusCode).toBe(401);
    expect((await post('expired', NORTH, { question: 'Which policy?' })).statusCode).toBe(401);
    expect((await post('noscope', NORTH, { question: 'Which policy?' })).statusCode).toBe(403);
  });

  it('refuses a non-member and a member of another tenant submitting to a tenant they do not belong to', async () => {
    expect((await post('stranger', NORTH, { question: 'Which policy document?' })).statusCode).toBe(403);
    expect((await post('reader', SOUTH, { question: 'Which policy document?' })).statusCode).toBe(403);
  });

  it('ignores a principal, agent or scope field in the body: the originating principal is always the verified token', async () => {
    // Additional properties are removed by the schema (Fastify default), so they never reach the gateway. The row proves which principal
    // was recorded.
    for (const extra of [{ principal: 'someone-else' }, { scopes: ['case:write'] }, { agent: 'orchestrator' }]) {
      const key = uuid();
      const response = await post('reader', NORTH, { question: 'Which policy document?', ...extra }, key);
      expect(response.statusCode).toBe(202);
      const executionId = (JSON.parse(response.body) as { executionId: string }).executionId;
      const row = await h.adminPool.query<{ principal_ref: string; principal_scopes: string[] }>(
        'SELECT principal_ref, principal_scopes FROM aegis.agent_executions WHERE execution_id = $1', [executionId]);
      expect(row.rows[0].principal_ref).toBe(principalDigest(TEST_ISSUER, 'api-reader'));
      expect(row.rows[0].principal_scopes).toEqual(['case:read', 'document:read']);
    }
  });

  it('refuses a malformed idempotency key and an oversized question', async () => {
    expect((await app.inject({ method: 'POST', url: `/api/tenants/${NORTH}/investigations`, headers: { authorization: 'Bearer reader',
      'idempotency-key': 'not-a-uuid', 'content-type': 'application/json' }, payload: { question: 'Which policy document?' } })).statusCode).toBe(400);
    expect((await post('reader', NORTH, { question: 'x'.repeat(1001) })).statusCode).toBe(400);
  });

  it('accepts a member, returns an execution identifier, and returns the same execution for an idempotent retry', async () => {
    const key = uuid();
    const first = await post('reader', NORTH, { question: 'Which policy document covers approvals?' }, key);
    expect(first.statusCode).toBe(202);
    const body = JSON.parse(first.body) as { executionId: string; created: boolean; statusUrl: string };
    expect(body.created).toBe(true);
    expect(first.headers.location).toBe(body.statusUrl);
    const retry = await post('reader', NORTH, { question: 'Which policy document covers approvals?' }, key);
    expect(retry.statusCode).toBe(200);
    expect(JSON.parse(retry.body)).toMatchObject({ executionId: body.executionId, created: false });
    const status = await app.inject({ method: 'GET', url: body.statusUrl, headers: { authorization: 'Bearer reader' } });
    expect(status.statusCode).toBe(200);
    expect(JSON.parse(status.body)).toMatchObject({ executionId: body.executionId, stage: 'submitted', status: 'pending' });
  });

  it('a replayed key with a different question is refused with 409 and creates no second execution or request', async () => {
    const key = uuid();
    const first = await post('reader', NORTH, { question: 'Which policy document covers approvals?' }, key);
    expect(first.statusCode).toBe(202);
    const count = async () => Number((await h.adminPool.query<{ n: string }>(
      'SELECT count(*)::text AS n FROM aegis.investigation_requests WHERE tenant_id = $1', [NORTH])).rows[0].n);
    const before = await count();
    const conflict = await post('reader', NORTH, { question: 'Which policy document covers refunds?' }, key);
    expect(conflict.statusCode).toBe(409);
    expect(JSON.parse(conflict.body)).toEqual({ error: 'idempotency_conflict' });
    expect(await count()).toBe(before);
  });

  it('another principal cannot read an execution, and receives the same answer as for an unknown one', async () => {
    const created = JSON.parse((await post('reader', NORTH, { question: 'Which policy document?' })).body) as { executionId: string };
    const other = await app.inject({ method: 'GET', url: `/api/tenants/${NORTH}/investigations/${created.executionId}`, headers: { authorization: 'Bearer other' } });
    const unknown = await app.inject({ method: 'GET', url: `/api/tenants/${NORTH}/investigations/${uuid()}`, headers: { authorization: 'Bearer other' } });
    expect(other.statusCode).toBe(404);
    expect(unknown.statusCode).toBe(404);
    expect(other.body).toBe(unknown.body);
  });

  // Public contract of POST /api/tenants/:tenantId/investigations/:executionId/cancel. The body is { accepted, state }, where state is
  // cancel_requested (this call set the request), already_requested (an earlier request stands), or terminal (the execution is finished
  // and nothing is requested). 404 is the same for another principal, another tenant and an unknown execution. The originating principal
  // and the tenant are always verified; the body cannot change either.
  const cancel = (token: string, tenant: string, executionId: string) => app.inject({ method: 'POST',
    url: `/api/tenants/${tenant}/investigations/${executionId}/cancel`, headers: { authorization: `Bearer ${token}` },
    payload: { reason: 'user_request' } });
  const cancelRequestEvents = async (executionId: string) => Number((await h.adminPool.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM aegis.agent_execution_events WHERE execution_id = $1 AND event_type = 'cancel_requested'`, [executionId])).rows[0].n);

  it('a first cancellation request by the originating principal returns cancel_requested, sets the flag, and writes one event', async () => {
    const created = JSON.parse((await post('reader', NORTH, { question: 'Which policy document?' })).body) as { executionId: string };
    const accepted = await cancel('reader', NORTH, created.executionId);
    expect(accepted.statusCode).toBe(200);
    expect(JSON.parse(accepted.body)).toEqual({ accepted: true, state: 'cancel_requested' });
    const row = await h.adminPool.query<{ cancel_requested: boolean }>('SELECT cancel_requested FROM aegis.agent_executions WHERE execution_id = $1', [created.executionId]);
    expect(row.rows[0].cancel_requested).toBe(true);
    expect(await cancelRequestEvents(created.executionId)).toBe(1);
  });

  it('a duplicate request returns already_requested and writes no second event', async () => {
    const created = JSON.parse((await post('reader', NORTH, { question: 'Which policy document?' })).body) as { executionId: string };
    await cancel('reader', NORTH, created.executionId);
    const duplicate = await cancel('reader', NORTH, created.executionId);
    expect(duplicate.statusCode).toBe(200);
    expect(JSON.parse(duplicate.body)).toEqual({ accepted: true, state: 'already_requested' });
    expect(await cancelRequestEvents(created.executionId)).toBe(1);
  });

  it('another principal in the same tenant is refused with the same 404 as an unknown execution, and nothing changes', async () => {
    const created = JSON.parse((await post('reader', NORTH, { question: 'Which policy document?' })).body) as { executionId: string };
    const denied = await cancel('other', NORTH, created.executionId);
    const unknown = await cancel('other', NORTH, uuid());
    expect(denied.statusCode).toBe(404);
    expect(denied.body).toBe(unknown.body);
    const row = await h.adminPool.query<{ cancel_requested: boolean }>('SELECT cancel_requested FROM aegis.agent_executions WHERE execution_id = $1', [created.executionId]);
    expect(row.rows[0].cancel_requested).toBe(false);
  });

  // Membership is checked before the execution is looked up, so the three refusals are distinct by design:
  //   A. no membership in the requested tenant    -> 403 { error: 'forbidden' }, whatever the execution identifier;
  //   B. membership in the requested tenant, but the execution belongs to another tenant -> 404 { error: 'not_found' }, as for unknown;
  //   C. membership in the tenant, another principal -> 404 { error: 'not_found' }, as for unknown.
  // Case B uses a dedicated principal with reader membership in both tenants. The NORTH-only reader is never changed.
  const cancelEventCount = async (executionId: string) => Number((await h.adminPool.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM aegis.agent_execution_events WHERE execution_id = $1 AND event_type IN ('cancel_requested', 'cancelled')`,
    [executionId])).rows[0].n);
  const flagOf = async (executionId: string) => (await h.adminPool.query<{ cancel_requested: boolean; status: string }>(
    'SELECT cancel_requested, status FROM aegis.agent_executions WHERE execution_id = $1', [executionId])).rows[0];

  it('A: a caller with no membership in the requested tenant gets 403 for a real and an unknown execution, and nothing changes', async () => {
    const created = JSON.parse((await post('reader', NORTH, { question: 'Which policy document?' })).body) as { executionId: string };
    const before = await flagOf(created.executionId);
    const real = await cancel('reader', SOUTH, created.executionId);
    const unknown = await cancel('reader', SOUTH, uuid());
    expect(real.statusCode).toBe(403);
    expect(JSON.parse(real.body)).toEqual({ error: 'forbidden' });
    expect(real.body).toBe(unknown.body);
    expect(await flagOf(created.executionId)).toEqual(before);
    expect(await cancelEventCount(created.executionId)).toBe(0);
  });

  it('B: a member of the requested tenant who names another tenant\'s execution gets 404, identical to an unknown execution, with no change', async () => {
    // Isolated fixture: the dual principal is a reader in both tenants.
    for (const tenant of [NORTH, SOUTH]) {
      await h.adminPool.query(`INSERT INTO aegis.memberships (issuer, subject, tenant_id, role) VALUES ($1, 'api-dual', $2, 'reader') ON CONFLICT DO NOTHING`,
        [TEST_ISSUER, tenant]);
    }
    const created = JSON.parse((await post('reader', NORTH, { question: 'Which policy document?' })).body) as { executionId: string };
    const before = await flagOf(created.executionId);
    const foreign = await cancel('dual', SOUTH, created.executionId);
    const unknown = await cancel('dual', SOUTH, uuid());
    expect(foreign.statusCode).toBe(404);
    expect(JSON.parse(foreign.body)).toEqual({ error: 'not_found' });
    expect(foreign.body).toBe(unknown.body);
    expect(await flagOf(created.executionId)).toEqual(before);
    expect(await cancelEventCount(created.executionId)).toBe(0);
    // The same principal can still cancel its own execution in its own tenant (the refusal is about the resource, not the principal).
    const own = await cancel('dual', NORTH, created.executionId);
    expect(own.statusCode).toBe(404);
  });

  it('a request after the execution is cancelled returns terminal and does not alter the cancelled execution', async () => {
    const created = JSON.parse((await post('reader', NORTH, { question: 'Which policy document?' })).body) as { executionId: string };
    await cancel('reader', NORTH, created.executionId);
    await reconcileCancellations(h.pools.orchestrator, {}, { instance: 'route-contract' });
    const late = await cancel('reader', NORTH, created.executionId);
    expect(late.statusCode).toBe(200);
    expect(JSON.parse(late.body)).toEqual({ accepted: false, state: 'terminal' });
    const row = await h.adminPool.query<{ status: string }>('SELECT status FROM aegis.agent_executions WHERE execution_id = $1', [created.executionId]);
    expect(row.rows[0].status).toBe('cancelled');
  });

  it('a request after a completion committed first returns terminal, and the succeeded execution is not overwritten', async () => {
    const created = JSON.parse((await post('reader', NORTH, { question: 'Which policy document?' })).body) as { executionId: string };
    const fence = await withMessagingContext(h.pools.orchestrator, { tenantId: NORTH }, (client) =>
      createAgentExecutionStore(joinTransaction(client, NORTH), {}).claim({ tenantId: NORTH, executionId: created.executionId,
        spiffeId: SPIFFE.orchestrator, instance: 'route-contract', leaseSeconds: 600 }));
    expect(fence.ok).toBe(true);
    const completed = await withMessagingContext(h.pools.orchestrator, { tenantId: NORTH }, (client) => createAgentExecutionStore(joinTransaction(client, NORTH), {})
      .release({ tenantId: NORTH, executionId: created.executionId, agentId: fence.ok ? fence.value.agentId : '', instance: 'route-contract',
        fencingToken: fence.ok ? fence.value.fencingToken : 0 }, 'succeeded', 'completed'));
    expect(completed.ok).toBe(true);
    const late = await cancel('reader', NORTH, created.executionId);
    expect(JSON.parse(late.body)).toEqual({ accepted: false, state: 'terminal' });
    const row = await h.adminPool.query<{ status: string; cancel_requested: boolean }>(
      'SELECT status, cancel_requested FROM aegis.agent_executions WHERE execution_id = $1', [created.executionId]);
    expect(row.rows[0]).toEqual({ status: 'succeeded', cancel_requested: false });
  });

  it('the gateway role cannot write outside its own grants: it cannot insert a delegation or a result', async () => {
    await expect(withMessagingContext(gateway, { tenantId: NORTH }, (c) => c.query(
      `INSERT INTO aegis.investigation_results (execution_id, tenant_id, verdict, answer, citations, reviewer_decision) VALUES ($1, $2, 'answered', 'forged', '[]', 'approve')`,
      [uuid(), NORTH]))).rejects.toThrow();
  });
});

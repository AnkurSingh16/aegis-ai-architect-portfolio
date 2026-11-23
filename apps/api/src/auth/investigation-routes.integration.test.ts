import Fastify from 'fastify';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuthorizationError, type VerifiedPrincipal } from './token.js';
import { registerInvestigationRoutes } from './investigation-routes.js';
import { createHarness, closeHarness, NORTH, SOUTH, TEST_ISSUER, type Harness } from '../orchestration/messaging/testing/support.js';
import { withMessagingContext } from '../orchestration/messaging/context.js';
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

  it('a cancellation request from the originating principal is recorded; another principal cannot cancel', async () => {
    const created = JSON.parse((await post('reader', NORTH, { question: 'Which policy document?' })).body) as { executionId: string };
    const denied = await app.inject({ method: 'POST', url: `/api/tenants/${NORTH}/investigations/${created.executionId}/cancel`,
      headers: { authorization: 'Bearer other' }, payload: { reason: 'user_request' } });
    expect(denied.statusCode).toBe(404);
    const accepted = await app.inject({ method: 'POST', url: `/api/tenants/${NORTH}/investigations/${created.executionId}/cancel`,
      headers: { authorization: 'Bearer reader' }, payload: { reason: 'user_request' } });
    expect(accepted.statusCode).toBe(200);
    expect(JSON.parse(accepted.body)).toEqual({ accepted: true });
    const row = await h.adminPool.query<{ cancel_requested: boolean }>('SELECT cancel_requested FROM aegis.agent_executions WHERE execution_id = $1', [created.executionId]);
    expect(row.rows[0].cancel_requested).toBe(true);
  });

  it('the gateway role cannot write outside its own grants: it cannot insert a delegation or a result', async () => {
    await expect(withMessagingContext(gateway, { tenantId: NORTH }, (c) => c.query(
      `INSERT INTO aegis.investigation_results (execution_id, tenant_id, verdict, answer, citations, reviewer_decision) VALUES ($1, $2, 'answered', 'forged', '[]', 'approve')`,
      [uuid(), NORTH]))).rejects.toThrow();
  });
});

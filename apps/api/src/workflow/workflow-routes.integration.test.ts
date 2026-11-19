import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { createDatabasePool } from '../storage/database.js';
import { migrateDatabase } from '../storage/migrations.js';
import { AuthorizationError, type VerifiedPrincipal } from '../auth/token.js';
import { registerProtectedWorkflowRoutes } from './workflow-routes.js';

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

const verify = async (authorization: string | undefined): Promise<VerifiedPrincipal> => {
  if (authorization === 'Bearer reader') return readerPrincipal;
  if (authorization === 'Bearer no-scope') return noScopePrincipal;
  if (authorization === 'Bearer stranger') return stranger;
  throw new AuthorizationError(401);
};

const key = () => randomUUID();
const post = (tenant: string, headers: Record<string, string>, body: unknown) =>
  app.inject({ method: 'POST', url: `/api/tenants/${tenant}/workflows/triage`, headers: { 'content-type': 'application/json', ...headers }, payload: body as object });

beforeAll(async () => {
  await migrateDatabase(adminUrl, process.env.DATABASE_APP_PASSWORD ?? '', process.env.DATABASE_INGEST_PASSWORD ?? '');
  await admin.query("INSERT INTO aegis.tenants (id, name) VALUES ($1, 'Synthetic North'), ($2, 'Synthetic South')", [tenantNorth, tenantSouth]);
  await admin.query("INSERT INTO aegis.memberships (issuer, subject, tenant_id, role) VALUES ($1, $2, $3, 'reader')", [issuer, readerSubject, tenantNorth]);
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

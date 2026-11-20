import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import { createDatabasePool } from '../storage/database.js';
import { migrateDatabase } from '../storage/migrations.js';
import { resolveFixture } from '../storage/config.js';
import { AuthorizationError, type VerifiedPrincipal } from '../auth/token.js';
import { syntheticDocuments } from '../documents/catalog.js';
import { ingestSyntheticCatalog } from '../documents/ingestion.js';
import { storeChunkEmbeddings } from '../retrieval/vector-retrieval.js';
import { EMBEDDING_DIMENSIONS } from '../retrieval/ollama-embeddings.js';
import type { TenantQueryable } from '../security/tool-approval-store.js';
import { registerProtectedAnswerRoutes } from './answer-routes.js';
import { GenerationError } from './ollama-generator.js';

// Real PostgreSQL + Fastify injection tests for the answer route. No model is called: the query embedding and the generator
// are injected, and the stored chunk vectors are fixed, so each case is deterministic.
const adminUrl = process.env.TEST_DATABASE_ADMIN_URL;
const runtimeUrl = process.env.TEST_DATABASE_URL;
const ingestionUrl = process.env.TEST_DOCUMENT_INGEST_URL;
const runtimePassword = process.env.DATABASE_APP_PASSWORD;
const ingestionPassword = process.env.DATABASE_INGEST_PASSWORD;
if (!adminUrl || !runtimeUrl || !ingestionUrl || !runtimePassword || !ingestionPassword) {
  throw new Error('Set the isolated PostgreSQL test URLs and role passwords for real PostgreSQL tests.');
}

const north = resolveFixture('north');
const south = resolveFixture('south');
const issuer = 'https://answer-routes.integration.example/';
const prefix = `answer-${randomUUID()}`;
const readerSubject = `${prefix}|reader`;
const strangerSubject = `${prefix}|stranger`;
const admin = new Pool({ connectionString: adminUrl, max: 1 });
const runtime = createDatabasePool(runtimeUrl, 4);
const ingestion = new Pool({ connectionString: ingestionUrl, max: 1 });

const reader: VerifiedPrincipal = { issuer, subject: readerSubject, scopes: new Set(['read:cases']) };
const noScope: VerifiedPrincipal = { issuer, subject: readerSubject, scopes: new Set() };
const stranger: VerifiedPrincipal = { issuer, subject: strangerSubject, scopes: new Set(['read:cases']) };

const verify = async (authorization: string | undefined): Promise<VerifiedPrincipal> => {
  if (authorization === 'Bearer reader') return reader;
  if (authorization === 'Bearer no-scope') return noScope;
  if (authorization === 'Bearer stranger') return stranger;
  throw new AuthorizationError(401);
};

/** A unit vector with a 1 at one index. The stored chunk vectors and the query vectors use the same indices. */
const vectorAt = (index: number): number[] => Array.from({ length: EMBEDDING_DIMENSIONS }, (_, i) => (i === index ? 1 : 0));
const SOURCE_INDEX: Record<string, number> = {
  'SYNTHETIC-NORTH-LOGIN-INCIDENT': 6,
  'SYNTHETIC-NORTH-MFA-GUIDANCE': 5,
  'SYNTHETIC-NORTH-ACCOUNT-RECOVERY': 7,
  'SYNTHETIC-NORTH-NETWORK-DIAGNOSTICS': 8,
};
const UNMATCHED_INDEX = 700;

// A question containing "factor" embeds to the MFA vector. Any other question embeds to a vector that no chunk matches.
const embedQuery = async (query: string) => (query.includes('factor') ? vectorAt(SOURCE_INDEX['SYNTHETIC-NORTH-MFA-GUIDANCE']!) : vectorAt(UNMATCHED_INDEX));
const generate = async ({ evidence }: { evidence: readonly { sourceId: string }[] }) => `Confirm the test factor [${evidence[0]!.sourceId}].`;

let app: FastifyInstance;
let failingApp: FastifyInstance;

beforeAll(async () => {
  await migrateDatabase(adminUrl, runtimePassword, ingestionPassword);
  await admin.query('INSERT INTO aegis.memberships (issuer,subject,tenant_id,role) VALUES ($1,$2,$3,$4)', [issuer, readerSubject, north.tenantId, 'reader']);
  await ingestSyntheticCatalog(ingestion);
  const chunks = (await admin.query<{ id: string; source_identity: string }>(
    'SELECT id, source_identity FROM aegis.document_chunks WHERE tenant_id = $1 AND document_version = 1', [north.tenantId])).rows;
  const rows = chunks.map((chunk) => ({ chunkId: chunk.id, vector: vectorAt(SOURCE_INDEX[chunk.source_identity]!) }));
  const stored = await admin.connect().then(async (client) => {
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('aegis.tenant_id', $1, true)", [north.tenantId]);
      const count = await storeChunkEmbeddings(client as unknown as TenantQueryable, north.tenantId, rows);
      await client.query('COMMIT');
      return count;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  });
  expect(stored).toBe(chunks.length);

  app = Fastify();
  await app.register(async (scoped) => registerProtectedAnswerRoutes(scoped, runtime, verify, { embedQuery, generate }));
  await app.ready();

  failingApp = Fastify();
  await failingApp.register(async (scoped) => registerProtectedAnswerRoutes(scoped, runtime, verify, {
    embedQuery,
    generate: async () => { throw new GenerationError('generation service unavailable'); },
  }));
  await failingApp.ready();
}, 120000);

afterAll(async () => {
  await Promise.all([app?.close(), failingApp?.close()]);
  // Remove only the rows this file wrote, so later integration files in the same database see only their own data.
  const tenants = [north.tenantId, south.tenantId];
  const identities = syntheticDocuments.map((document) => document.sourceIdentity);
  try {
    await admin.query(`DELETE FROM aegis.chunk_embeddings WHERE chunk_id IN (
      SELECT id FROM aegis.document_chunks WHERE tenant_id = ANY($1::uuid[]) AND source_identity = ANY($2::text[]))`, [tenants, identities]);
    await admin.query('DELETE FROM aegis.document_chunks WHERE tenant_id = ANY($1::uuid[]) AND source_identity = ANY($2::text[])', [tenants, identities]);
    await admin.query('DELETE FROM aegis.documents WHERE tenant_id = ANY($1::uuid[]) AND source_identity = ANY($2::text[])', [tenants, identities]);
    await admin.query('DELETE FROM aegis.memberships WHERE issuer=$1 AND subject LIKE $2', [issuer, `${prefix}|%`]);
  } finally { await Promise.all([admin.end(), runtime.end(), ingestion.end()]); }
});

const ask = (instance: FastifyInstance, tenantId: string, authorization: string | undefined, body: unknown, headers: Record<string, string> = {}) =>
  instance.inject({
    method: 'POST', url: `/api/tenants/${tenantId}/answers`,
    headers: { 'content-type': 'application/json', ...(authorization ? { authorization } : {}), ...headers },
    payload: body as object,
  });

describe('POST /api/tenants/:tenantId/answers', () => {
  it('answers a question that matches a stored North document, with its citation', async () => {
    const response = await ask(app, north.tenantId, 'Bearer reader', { question: 'How is a second factor checked?' });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { status: string; answer: string; citations: string[] };
    expect(body.status).toBe('answered');
    expect(body.citations).toEqual(['SYNTHETIC-NORTH-MFA-GUIDANCE']);
    expect(body.answer).toContain('[SYNTHETIC-NORTH-MFA-GUIDANCE]');
  });

  it('abstains when no stored chunk reaches the floor', async () => {
    const response = await ask(app, north.tenantId, 'Bearer reader', { question: 'What is the capital of France?' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: 'abstained', reason: 'insufficient_evidence' });
  });

  it('refuses a request with no token, with 401', async () => {
    const response = await ask(app, north.tenantId, undefined, { question: 'How is a second factor checked?' });
    expect(response.statusCode).toBe(401);
  });

  it('refuses a token without the read scope, with 403', async () => {
    const response = await ask(app, north.tenantId, 'Bearer no-scope', { question: 'How is a second factor checked?' });
    expect(response.statusCode).toBe(403);
  });

  it('refuses a caller who is not a member of the tenant, with 403', async () => {
    const response = await ask(app, north.tenantId, 'Bearer stranger', { question: 'How is a second factor checked?' });
    expect(response.statusCode).toBe(403);
  });

  it('refuses a North member who asks about the South tenant, with 403', async () => {
    const response = await ask(app, south.tenantId, 'Bearer reader', { question: 'How is a second factor checked?' });
    expect(response.statusCode).toBe(403);
  });

  it('rejects a blank question with 400', async () => {
    const response = await ask(app, north.tenantId, 'Bearer reader', { question: '   ' });
    expect(response.statusCode).toBe(400);
  });

  it('returns 503 with no detail when generation is unavailable', async () => {
    const response = await ask(failingApp, north.tenantId, 'Bearer reader', { question: 'How is a second factor checked?' });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ error: 'Answer service is unavailable. Please retry.' });
  });

  it('logs the outcome and correlation id, and never the question or the answer', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    try {
      const question = 'How is a second factor checked?';
      await ask(app, north.tenantId, 'Bearer reader', { question }, { 'x-correlation-id': 'answer-trace-1' });
      const lines = info.mock.calls.map((call) => String(call[0]));
      const record = lines.map((line) => JSON.parse(line) as Record<string, unknown>).find((line) => line.event === 'answer_request');
      expect(record).toMatchObject({ event: 'answer_request', correlationId: 'answer-trace-1', outcome: 'answered' });
      expect(lines.join('\n')).not.toContain('second factor');
      expect(lines.join('\n')).not.toContain('Confirm the test factor');
    } finally {
      info.mockRestore();
    }
  });
});

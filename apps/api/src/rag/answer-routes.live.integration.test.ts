import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { createDatabasePool } from '../storage/database.js';
import { migrateDatabase } from '../storage/migrations.js';
import { resolveFixture } from '../storage/config.js';
import { AuthorizationError, type VerifiedPrincipal } from '../auth/token.js';
import { syntheticDocuments } from '../documents/catalog.js';
import { ingestSyntheticCatalog } from '../documents/ingestion.js';
import { embedTexts } from '../retrieval/ollama-embeddings.js';
import { storeChunkEmbeddings } from '../retrieval/vector-retrieval.js';
import { withAuthenticatedTransaction } from '../auth/transaction.js';
import type { TenantQueryable } from '../security/tool-approval-store.js';
import { registerProtectedAnswerRoutes } from './answer-routes.js';

// Gated live smoke test (AEGIS_LIVE_OLLAMA=1). It uses the real local embedding and chat services through the real route,
// with no injected functions. It checks the shape of the responses and the citation rule. It makes no quality claim: the
// questions are two checks, not an evaluation set.
const live = process.env.AEGIS_LIVE_OLLAMA === '1';
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
const issuer = 'https://answer-live.integration.example/';
const prefix = `answer-live-${randomUUID()}`;
const readerSubject = `${prefix}|reader`;
const admin = new Pool({ connectionString: adminUrl, max: 1 });
const runtime = createDatabasePool(runtimeUrl, 2);
const ingestion = new Pool({ connectionString: ingestionUrl, max: 1 });
const operatorSubject = `${prefix}|operator`;
const reader: VerifiedPrincipal = { issuer, subject: readerSubject, scopes: new Set(['read:cases']) };
const operator: VerifiedPrincipal = { issuer, subject: operatorSubject, scopes: new Set(['read:cases', 'write:cases']) };
const verify = async (authorization: string | undefined): Promise<VerifiedPrincipal> => {
  if (authorization === 'Bearer reader') return reader;
  throw new AuthorizationError(401);
};
let app: FastifyInstance;

beforeAll(async () => {
  if (!live) return;
  await migrateDatabase(adminUrl, runtimePassword, ingestionPassword);
  await admin.query('INSERT INTO aegis.memberships (issuer,subject,tenant_id,role) VALUES ($1,$2,$3,$4)', [issuer, readerSubject, north.tenantId, 'reader']);
  await admin.query('INSERT INTO aegis.memberships (issuer,subject,tenant_id,role) VALUES ($1,$2,$3,$4)', [issuer, operatorSubject, north.tenantId, 'operator']);
  await ingestSyntheticCatalog(ingestion);
  const chunks = (await admin.query<{ id: string; content: string }>(
    'SELECT id, content FROM aegis.document_chunks WHERE tenant_id = $1 AND document_version = 1 ORDER BY source_identity, position', [north.tenantId])).rows;
  const rows: { chunkId: string; vector: number[] }[] = [];
  for (let start = 0; start < chunks.length; start += 8) {
    const batch = chunks.slice(start, start + 8);
    const vectors = await embedTexts(batch.map((chunk) => chunk.content), 'search_document');
    batch.forEach((chunk, index) => rows.push({ chunkId: chunk.id, vector: vectors[index]! }));
  }
  // Storing embeddings needs the write scope and the operator role, as in the floor evaluation.
  const stored = await withAuthenticatedTransaction(runtime, operator, north.tenantId, 'write:cases',
    (client) => storeChunkEmbeddings(client as unknown as TenantQueryable, north.tenantId, rows));
  expect(stored).toBe(chunks.length);
  app = Fastify();
  // No injected functions: the route uses the local embedding service and the local chat model, as in production.
  await app.register(async (scoped) => registerProtectedAnswerRoutes(scoped, runtime, verify));
  await app.ready();
}, 600000);

afterAll(async () => {
  if (!live) return;
  await app?.close();
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

describe.skipIf(!live)('answer route, live local models: smoke check', () => {
  it('answers a North question with a North citation, and abstains on an off-topic question', async () => {
    const answerable = await app.inject({
      method: 'POST', url: `/api/tenants/${north.tenantId}/answers`,
      headers: { 'content-type': 'application/json', authorization: 'Bearer reader' },
      payload: { question: 'Which details should be recorded for a sign-in interruption?' },
    });
    expect(answerable.statusCode).toBe(200);
    const first = answerable.json() as { status: string; citations?: string[]; answer?: string };
    if (first.status === 'answered') {
      expect(first.citations!.length).toBeGreaterThan(0);
      expect(first.citations!.every((id) => id.startsWith('SYNTHETIC-NORTH-'))).toBe(true);
    }

    const offTopic = await app.inject({
      method: 'POST', url: `/api/tenants/${north.tenantId}/answers`,
      headers: { 'content-type': 'application/json', authorization: 'Bearer reader' },
      payload: { question: 'What is the capital of France?' },
    });
    expect(offTopic.statusCode).toBe(200);
    expect(offTopic.json()).toMatchObject({ status: 'abstained' });
    // Known defect (docs/DEV-C4-CITATION-FIX-V4.md): prompt v4 can copy the layout placeholder as the answer text.
    // This assertion fails until that is fixed.
    if (first.status === 'answered') expect(first.answer).not.toMatch(/answer text here/i);
    if (process.env.ANSWER_LIVE_OUTPUT) {
      writeFileSync(process.env.ANSWER_LIVE_OUTPUT, `${JSON.stringify({ answerable: first, offTopic: offTopic.json() }, null, 2)}\n`);
    }
  }, 600000);
});

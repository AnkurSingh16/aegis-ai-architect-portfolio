import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { createDatabasePool } from '../storage/database.js';
import { migrateDatabase } from '../storage/migrations.js';
import { resolveFixture } from '../storage/config.js';
import { withAuthenticatedTransaction } from '../auth/transaction.js';
import type { VerifiedPrincipal } from '../auth/token.js';
import type { TenantQueryable } from '../security/tool-approval-store.js';
import { syntheticDocuments } from '../documents/catalog.js';
import { ingestSyntheticCatalog } from '../documents/ingestion.js';
import { embedTexts } from '../retrieval/ollama-embeddings.js';
import { storeChunkEmbeddings } from '../retrieval/vector-retrieval.js';
import { answerWithSelfCorrection, type Evidence } from './self-correcting-answer.js';
import { vectorEvidenceRetriever, type ClientRunner } from './document-evidence.js';
import { abstentionCases } from './abstention-cases.js';
import { scoreAbstentionCases, type CaseOutcome } from './abstention-evaluation.js';

// Gated: needs the local loopback embedding service (AEGIS_LIVE_OLLAMA=1). Labelled development evaluation of the
// answer loop over vector retrieval. The generator is the same deterministic stub as the lexical evaluation.
// The similarity floor below was declared before the first live run and is not tuned afterwards.
const MIN_SIMILARITY = 0.5;

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
const issuer = 'https://synthetic-vector-eval.integration.example/';
const prefix = `vector-eval-${randomUUID()}`;
const subject = `${prefix}|operator`;
const admin = new Pool({ connectionString: adminUrl, max: 1 });
const runtime = createDatabasePool(runtimeUrl, 2);
const ingestion = new Pool({ connectionString: ingestionUrl, max: 1 });
const principal: VerifiedPrincipal = { issuer, subject, scopes: new Set(['read:cases', 'write:cases']) };
const run: ClientRunner = (operation) => withAuthenticatedTransaction(runtime, principal, north.tenantId, 'read:cases', operation);

beforeAll(async () => {
  if (!live) return;
  await migrateDatabase(adminUrl, runtimePassword, ingestionPassword);
  await admin.query('INSERT INTO aegis.memberships (issuer,subject,tenant_id,role) VALUES ($1,$2,$3,$4)', [issuer, subject, north.tenantId, 'operator']);
  await ingestSyntheticCatalog(ingestion);
  const chunks = (await admin.query<{ id: string; content: string }>(
    'SELECT id, content FROM aegis.document_chunks WHERE tenant_id = $1 AND document_version = 1 ORDER BY source_identity, position', [north.tenantId])).rows;
  const rows: { chunkId: string; vector: number[] }[] = [];
  for (let start = 0; start < chunks.length; start += 8) {
    const batch = chunks.slice(start, start + 8);
    const vectors = await embedTexts(batch.map((chunk) => chunk.content), 'search_document');
    batch.forEach((chunk, index) => rows.push({ chunkId: chunk.id, vector: vectors[index]! }));
  }
  const stored = await withAuthenticatedTransaction(runtime, principal, north.tenantId, 'write:cases',
    (client) => storeChunkEmbeddings(client as unknown as TenantQueryable, north.tenantId, rows));
  expect(stored).toBe(chunks.length);
}, 120000);

afterAll(async () => {
  // Remove only the rows this file wrote, so later integration files in the same database see only their own data.
  const tenants = [north.tenantId, resolveFixture('south').tenantId];
  const identities = syntheticDocuments.map((document) => document.sourceIdentity);
  try {
    await admin.query(`DELETE FROM aegis.chunk_embeddings WHERE chunk_id IN (
      SELECT id FROM aegis.document_chunks WHERE tenant_id = ANY($1::uuid[]) AND source_identity = ANY($2::text[]))`, [tenants, identities]);
    await admin.query('DELETE FROM aegis.document_chunks WHERE tenant_id = ANY($1::uuid[]) AND source_identity = ANY($2::text[])', [tenants, identities]);
    await admin.query('DELETE FROM aegis.documents WHERE tenant_id = ANY($1::uuid[]) AND source_identity = ANY($2::text[])', [tenants, identities]);
    await admin.query('DELETE FROM aegis.memberships WHERE issuer=$1 AND subject LIKE $2', [issuer, `${prefix}|%`]);
  } finally { await Promise.all([admin.end(), runtime.end(), ingestion.end()]); }
});

describe.skipIf(!live)('labelled abstention evaluation over vector retrieval (live embeddings)', () => {
  it('runs every labelled case through vector retrieval and reports the decisions with their top similarity', async () => {
    const embedQuery = async (query: string) => (await embedTexts([query], 'search_query'))[0]!;
    const retrieve = vectorEvidenceRetriever({ run, tenantId: north.tenantId, embedQuery, topK: 5 });
    const outcomes: CaseOutcome[] = [];
    const topSimilarity: (number | null)[] = [];
    for (const labelled of abstentionCases) {
      let top: number | null = null;
      const result = await answerWithSelfCorrection(labelled.question, {
        retrieve: async (query: string): Promise<Evidence[]> => {
          const evidence = await retrieve(query);
          if (top === null && evidence.length > 0) top = Math.max(...evidence.map((item) => item.score));
          return evidence;
        },
        generate: async ({ evidence }) => `Based on the synthetic document [${evidence[0]!.sourceId}].`,
        reformulate: async () => null,
      }, { maxRounds: 2, minScore: MIN_SIMILARITY, forbiddenSubstrings: ['SENTINEL-XYZ'] });
      outcomes.push(result.status === 'answered' ? { status: 'answered', citations: result.citations } : { status: 'abstained' });
      topSimilarity.push(top);
    }
    const report = scoreAbstentionCases(abstentionCases, outcomes);
    const detail = abstentionCases.map((labelled, index) => ({
      id: labelled.id, expected: labelled.expected, outcome: outcomes[index], topSimilarity: topSimilarity[index],
    }));
    if (process.env.C4_VECTOR_EVAL_OUTPUT) {
      writeFileSync(process.env.C4_VECTOR_EVAL_OUTPUT, `${JSON.stringify({ minSimilarity: MIN_SIMILARITY, report, detail }, null, 2)}\n`);
    }
    expect(report.total).toBe(abstentionCases.length);
  });
});

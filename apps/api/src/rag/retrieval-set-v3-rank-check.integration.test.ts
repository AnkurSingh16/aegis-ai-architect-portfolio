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
import type { Evidence } from './self-correcting-answer.js';
import { vectorEvidenceRetriever, type ClientRunner } from './document-evidence.js';
import { retrievalSetV3Primary, retrievalSetV3Spares } from './retrieval-set-v3-cases.js';
const cases = [...retrievalSetV3Primary, ...retrievalSetV3Spares];

// Gated: step 2 of docs/DEV-C4-RETRIEVAL-SET-PROTOCOL.md. Raw vector retrieval only: no reranker, no generator, no floor.
// Writes each expected document rank and the top scores to C4_RANK_OUTPUT. Nothing is dropped here; the drop rule is applied after.
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
const issuer = 'https://synthetic-rerank.integration.example/';
const prefix = `rerank-${randomUUID()}`;
const subject = `${prefix}|operator`;
const admin = new Pool({ connectionString: adminUrl, max: 1 });
const runtime = createDatabasePool(runtimeUrl, 2);
const ingestion = new Pool({ connectionString: ingestionUrl, max: 1 });
const principal: VerifiedPrincipal = { issuer, subject, scopes: new Set(['read:cases', 'write:cases']) };
const run: ClientRunner = (operation) => withAuthenticatedTransaction(runtime, principal, north.tenantId, 'read:cases', operation);
const embedQuery = async (query: string) => (await embedTexts([query], 'search_query'))[0]!;
const retrieveRaw = vectorEvidenceRetriever({ run, tenantId: north.tenantId, embedQuery, topK: 5 });

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

/** 1-based rank of the expected source in the list, counting the first item per source; null when absent. */
function rankOf(items: readonly Evidence[], sourceId: string): number | null {
  const index = items.findIndex((item) => item.sourceId === sourceId);
  return index === -1 ? null : index + 1;
}

describe.skipIf(!live)('live rank check: raw vector retrieval only, set v2', () => {
  it('records the raw rank of each expected document and the top score', async () => {
    const rows: { id: string; replacesId: string | null; kind: string; expected: string | null; rank: number | null; topSourceId: string | null; topScore: number | null; top: { sourceId: string; score: number }[] }[] = [];
    for (const labelled of cases) {
      const hits = await retrieveRaw(labelled.question);
      const expected = labelled.expected.kind === 'answer' ? labelled.expected.sourceId : null;
      rows.push({
        id: labelled.id, replacesId: (labelled as { replacesId?: string }).replacesId ?? null, kind: labelled.expected.kind, expected, rank: expected ? rankOf(hits, expected) : null,
        topSourceId: hits[0]?.sourceId ?? null, topScore: hits[0]?.score ?? null,
        top: hits.map((hit) => ({ sourceId: hit.sourceId, score: hit.score })),
      });
    }
    if (process.env.C4_RANK_OUTPUT) writeFileSync(process.env.C4_RANK_OUTPUT, `${JSON.stringify({ setName: 'retrieval-set-v3', embedModel: 'nomic-embed-text', rows }, null, 2)}\n`);
    expect(rows).toHaveLength(cases.length);
  }, 1_800_000);
});

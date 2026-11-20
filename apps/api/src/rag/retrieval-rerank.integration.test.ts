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
import { createOllamaReranker, RERANKER_PROMPT_VERSION } from './ollama-reranker.js';
import { createOllamaGenerator, GENERATOR_MODEL, GENERATOR_MODEL_DIGEST } from './ollama-generator.js';
import { ANSWER_POLICY } from './answer-routes.js';
import { retrievalRerankCasesV1 } from './retrieval-rerank-cases-v1.js';
import { scoreAbstentionCases, type CaseOutcome } from './abstention-evaluation.js';

// Gated: the single pre-registered run of docs/DEV-C4-RERANK-PROTOCOL.md. Not run until the owner says so. Writes the paired
// report (raw order and reranked order from the same retrieval) to C4_RERANK_OUTPUT. Asserts only that every case ran.
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
const rerank = createOllamaReranker();

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

describe.skipIf(!live)('live retrieval rerank: one pre-registered paired run', () => {
  it('runs raw and reranked retrieval over the set and writes the report', async () => {
    const pairs: { id: string; expected: (typeof retrievalRerankCasesV1)[number]['expected']; raw: Evidence[]; reranked: Evidence[]; outcome: string; rerankMs: number; rawRank: number | null; rerankRank: number | null }[] = [];
    for (const labelled of retrievalRerankCasesV1) {
      const raw = await retrieveRaw(labelled.question);
      const started = Date.now();
      const result = await rerank(labelled.question, raw);
      const rerankMs = Date.now() - started;
      const expectedSource = labelled.expected.kind === 'answer' ? labelled.expected.sourceId : '';
      pairs.push({
        id: labelled.id, expected: labelled.expected, raw, reranked: [...result.order], outcome: result.outcome, rerankMs,
        rawRank: rankOf(raw, expectedSource), rerankRank: rankOf(result.order, expectedSource),
      });
    }

    // Safety: the answer loop with the route's policy and prompt v4, run on the reranked order. Retrieval is the only change.
    const generate = createOllamaGenerator(undefined, 'v4');
    const safety: { id: string; status: string; citations?: readonly string[]; reason?: string }[] = [];
    for (const pair of pairs) {
      const retrieveReranked = async (query: string): Promise<Evidence[]> => {
        const items = await retrieveRaw(query);
        return [...(await rerank(query, items)).order];
      };
      const result = await answerWithSelfCorrection(
        retrievalRerankCasesV1.find((c) => c.id === pair.id)!.question,
        { retrieve: retrieveReranked, generate, reformulate: async () => null },
        ANSWER_POLICY,
      );
      safety.push(result.status === 'answered'
        ? { id: pair.id, status: 'answered', citations: result.citations }
        : { id: pair.id, status: 'abstained', reason: result.reason });
    }
    const outcomes: CaseOutcome[] = safety.map((row) => (row.status === 'answered'
      ? { status: 'answered', citations: row.citations ?? [] }
      : { status: 'abstained' }));
    const report = scoreAbstentionCases(retrievalRerankCasesV1.map((c) => ({ id: c.id, question: '', expected: c.expected })), outcomes);

    const answerable = pairs.filter((pair) => pair.expected.kind === 'answer');
    const topOne = (rank: (pair: (typeof pairs)[number]) => number | null) => answerable.filter((pair) => rank(pair) === 1).length;
    const mrr = (rank: (pair: (typeof pairs)[number]) => number | null) => answerable.reduce((sum, pair) => sum + (rank(pair) ? 1 / rank(pair)! : 0), 0) / answerable.length;
    const latencies = pairs.map((pair) => pair.rerankMs).sort((a, b) => a - b);
    const summary = {
      answerable: answerable.length,
      topOneRaw: topOne((pair) => pair.rawRank),
      topOneReranked: topOne((pair) => pair.rerankRank),
      mrrRaw: mrr((pair) => pair.rawRank),
      mrrReranked: mrr((pair) => pair.rerankRank),
      outcomes: pairs.reduce<Record<string, number>>((acc, pair) => ({ ...acc, [pair.outcome]: (acc[pair.outcome] ?? 0) + 1 }), {}),
      rerankLatencyMs: { median: latencies[Math.floor(latencies.length / 2)], max: latencies[latencies.length - 1] },
    };

    if (process.env.C4_RERANK_OUTPUT) {
      writeFileSync(process.env.C4_RERANK_OUTPUT, `${JSON.stringify({
        model: GENERATOR_MODEL, modelDigest: GENERATOR_MODEL_DIGEST, rerankPrompt: RERANKER_PROMPT_VERSION,
        answerPrompt: 'v4', floor: ANSWER_POLICY.minScore, policy: ANSWER_POLICY, setName: 'retrieval-rerank-v1',
        summary, safetyReport: report, pairs, safety,
      }, null, 2)}\n`);
    }
    expect(pairs).toHaveLength(retrievalRerankCasesV1.length);
  }, 3_600_000);
});

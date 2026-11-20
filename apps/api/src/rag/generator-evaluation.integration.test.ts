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
import type { LabelledCase } from './abstention-cases.js';
import { generatorEvalCases } from './generator-cases.js';
import { generatorEvalCasesV2 } from './generator-cases-v2.js';
import { generatorEvalCasesV3 } from './generator-cases-v3.js';
import { createOllamaGenerator, GenerationError, GENERATOR_MODEL, type PromptVersion } from './ollama-generator.js';
import { scoreAbstentionCases, type CaseOutcome } from './abstention-evaluation.js';

// Gated: the pre-registered run of the live generator (docs/DEV-C4-GENERATOR-EVALUATION.md). It runs once per set. It
// writes the report to C4_GENERATOR_OUTPUT and asserts only that every case ran; quality is read from the report.
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
const issuer = 'https://synthetic-generator.integration.example/';
const prefix = `generator-${randomUUID()}`;
const subject = `${prefix}|operator`;
const admin = new Pool({ connectionString: adminUrl, max: 1 });
const runtime = createDatabasePool(runtimeUrl, 2);
const ingestion = new Pool({ connectionString: ingestionUrl, max: 1 });
const principal: VerifiedPrincipal = { issuer, subject, scopes: new Set(['read:cases', 'write:cases']) };
const run: ClientRunner = (operation) => withAuthenticatedTransaction(runtime, principal, north.tenantId, 'read:cases', operation);
const embedQuery = async (query: string) => (await embedTexts([query], 'search_query'))[0]!;
const retrieve = vectorEvidenceRetriever({ run, tenantId: north.tenantId, embedQuery, topK: 5 });

// Fixed for this run. Identical to the floor evaluation and to docs/DEV-C4-GENERATOR-EVALUATION.md.
const FLOOR = 0.7;
const POLICY = { maxRounds: 2, minScore: FLOOR, forbiddenSubstrings: ['SENTINEL-XYZ'] };
// Which pre-registered run this is. The default is the first run: set v1 with prompt v1. The citation fix is set v2
// with prompt v2 (docs/DEV-C4-CITATION-FIX.md). Nothing else changes between the two.
const RUN: 'v1' | 'v2' | 'v3' = process.env.C4_GENERATOR_RUN === 'v3' ? 'v3' : process.env.C4_GENERATOR_RUN === 'v2' ? 'v2' : 'v1';
const EVAL_SET = RUN === 'v3' ? generatorEvalCasesV3 : RUN === 'v2' ? generatorEvalCasesV2 : generatorEvalCases;
const PROMPT: PromptVersion = RUN;

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

interface CaseRecord {
  readonly id: string;
  readonly expected: LabelledCase['expected'];
  readonly status: 'answered' | 'abstained' | 'generation_failed';
  readonly reason?: string;
  readonly citations?: readonly string[];
  readonly answer?: string;
  readonly rounds?: number;
  readonly problemHistory?: readonly (readonly string[])[];
  readonly topScore: number | null;
  readonly topSourceId: string | null;
  readonly failureName?: string;
}

describe.skipIf(!live)('live generator evaluation: one pre-registered run', () => {
  it('runs the real loop once over the set and writes the report', async () => {
    const records: CaseRecord[] = [];
    for (const labelled of EVAL_SET) {
      let lastEvidence: readonly Evidence[] = [];
      const deps = {
        retrieve: async (query: string): Promise<Evidence[]> => {
          lastEvidence = await retrieve(query);
          return lastEvidence as Evidence[];
        },
        generate: createOllamaGenerator(undefined, PROMPT),
        reformulate: async () => null,
      };
      const top = (): { topScore: number | null; topSourceId: string | null } => ({
        topScore: lastEvidence[0]?.score ?? null,
        topSourceId: lastEvidence[0]?.sourceId ?? null,
      });
      try {
        const result = await answerWithSelfCorrection(labelled.question, deps, POLICY);
        if (result.status === 'answered') {
          records.push({
            id: labelled.id, expected: labelled.expected, status: 'answered', citations: result.citations,
            answer: result.answer.slice(0, 600), rounds: result.rounds, problemHistory: result.problemHistory, ...top(),
          });
        } else {
          records.push({
            id: labelled.id, expected: labelled.expected, status: 'abstained', reason: result.reason, rounds: result.rounds,
            problemHistory: result.problemHistory, ...top(),
          });
        }
      } catch (error) {
        // A generation failure is reported on its own. It is not an answer and not an abstention.
        const failureName = error instanceof GenerationError ? 'GenerationError' : 'unexpected';
        records.push({ id: labelled.id, expected: labelled.expected, status: 'generation_failed', failureName, ...top() });
      }
    }

    // Scored over the cases that completed. Generation failures are counted and excluded, not scored as abstentions.
    const scored = records.filter((record) => record.status !== 'generation_failed');
    const outcomes: CaseOutcome[] = scored.map((record) => (record.status === 'answered'
      ? { status: 'answered', citations: record.citations ?? [] }
      : { status: 'abstained' }));
    const scoredCases = scored.map((record) => ({ id: record.id, question: '', expected: record.expected }));
    const report = scoreAbstentionCases(scoredCases, outcomes);

    if (process.env.C4_GENERATOR_OUTPUT) {
      writeFileSync(process.env.C4_GENERATOR_OUTPUT, `${JSON.stringify({
        model: GENERATOR_MODEL,
        floor: FLOOR,
        policy: POLICY,
        run: RUN,
        promptVersion: PROMPT,
        setSize: EVAL_SET.length,
        generationFailures: records.filter((record) => record.status === 'generation_failed').length,
        scoredCases: scored.length,
        report,
        records,
      }, null, 2)}\n`);
    }
    expect(records).toHaveLength(EVAL_SET.length);
  }, 1_800_000);
});

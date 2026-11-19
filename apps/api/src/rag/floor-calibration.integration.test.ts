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
import { abstentionCases, type LabelledCase } from './abstention-cases.js';
import { holdoutCases } from './floor-cases.js';
import { calibrationCasesV2, holdoutCasesV2 } from './floor-cases-v2.js';
import { scoreAbstentionCases, type CaseOutcome } from './abstention-evaluation.js';
import { chooseFloor, outcomeAtFloor, sweepFloors, type RankedEvidence } from './floor-calibration.js';

// Gated: needs the local loopback embedding service (AEGIS_LIVE_OLLAMA=1). The floor is chosen on the calibration set
// with the fixed rule in docs/DEV-C4-FLOOR-CALIBRATION.md. The holdout is then run once through the real loop.
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
const issuer = 'https://synthetic-floor.integration.example/';
const prefix = `floor-${randomUUID()}`;
const subject = `${prefix}|operator`;
const admin = new Pool({ connectionString: adminUrl, max: 1 });
const runtime = createDatabasePool(runtimeUrl, 2);
const ingestion = new Pool({ connectionString: ingestionUrl, max: 1 });
const principal: VerifiedPrincipal = { issuer, subject, scopes: new Set(['read:cases', 'write:cases']) };
const run: ClientRunner = (operation) => withAuthenticatedTransaction(runtime, principal, north.tenantId, 'read:cases', operation);
const embedQuery = async (query: string) => (await embedTexts([query], 'search_query'))[0]!;
const retrieve = vectorEvidenceRetriever({ run, tenantId: north.tenantId, embedQuery, topK: 5 });

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

/** Top-five ranked evidence for each case, from one live retrieval per question. */
async function rankedEvidence(cases: readonly LabelledCase[]): Promise<RankedEvidence[][]> {
  const result: RankedEvidence[][] = [];
  for (const labelled of cases) {
    const evidence = await retrieve(labelled.question);
    result.push(evidence.map((item) => ({ sourceId: item.sourceId, score: item.score })));
  }
  return result;
}

/** Runs the real loop once per case at the given floor, with the same stub generator as the other evaluations. */
async function realLoop(cases: readonly LabelledCase[], floor: number): Promise<CaseOutcome[]> {
  const outcomes: CaseOutcome[] = [];
  for (const labelled of cases) {
    const result = await answerWithSelfCorrection(labelled.question, {
      retrieve: (query: string): Promise<Evidence[]> => retrieve(query),
      generate: async ({ evidence }) => `Based on the synthetic document [${evidence[0]!.sourceId}].`,
      reformulate: async () => null,
    }, { maxRounds: 2, minScore: floor, forbiddenSubstrings: ['SENTINEL-XYZ'] });
    outcomes.push(result.status === 'answered' ? { status: 'answered', citations: result.citations } : { status: 'abstained' });
  }
  return outcomes;
}

describe.skipIf(!live)('similarity floor: calibration, then one holdout run', () => {
  it('chooses the floor on calibration and tests it once on the holdout through the real loop', async () => {
    const calEvidence = await rankedEvidence(calibrationCasesV2);
    const { floor, rows } = chooseFloor(calibrationCasesV2, calEvidence);
    const holdEvidence = await rankedEvidence(holdoutCasesV2);
    const holdSweep = sweepFloors(holdoutCasesV2, holdEvidence);

    const holdLoop = await realLoop(holdoutCasesV2, floor);
    // The sweep is exact for this generator; the real loop must agree case by case.
    holdLoop.forEach((outcome, index) => expect(outcome).toEqual(outcomeAtFloor(holdEvidence[index]!, floor)));
    const holdReport = scoreAbstentionCases(holdoutCasesV2, holdLoop);

    // Reference only: the first holdout was already observed, so it is not a clean test any more.
    const firstHoldoutLoop = await realLoop(holdoutCases, floor);
    const firstHoldoutReport = scoreAbstentionCases(holdoutCases, firstHoldoutLoop);

    const referenceLoop = await realLoop(abstentionCases, floor);
    const referenceReport = scoreAbstentionCases(abstentionCases, referenceLoop);

    if (process.env.C4_FLOOR_OUTPUT) {
      writeFileSync(process.env.C4_FLOOR_OUTPUT, `${JSON.stringify({
        chosenFloor: floor,
        calibrationSweep: rows.map((row) => ({ floor: row.floor, ...row.report })),
        holdoutSweep: holdSweep.map((row) => ({ floor: row.floor, ...row.report })),
        holdoutRealLoop: holdReport,
        holdoutDetail: holdoutCasesV2.map((labelled, index) => ({ id: labelled.id, expected: labelled.expected, outcome: holdLoop[index], topScore: holdEvidence[index]?.[0]?.score ?? null })),
        firstHoldoutAtChosenFloor_seenBefore: firstHoldoutReport,
        originalFifteenAtChosenFloor_seenBefore: referenceReport,
      }, null, 2)}\n`);
    }
    expect(holdReport.total).toBe(holdoutCasesV2.length);
  });
});

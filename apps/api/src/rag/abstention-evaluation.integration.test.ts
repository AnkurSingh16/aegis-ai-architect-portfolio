import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { createDatabasePool } from '../storage/database.js';
import { migrateDatabase } from '../storage/migrations.js';
import { resolveFixture } from '../storage/config.js';
import { withAuthenticatedTransaction } from '../auth/transaction.js';
import type { VerifiedPrincipal } from '../auth/token.js';
import { syntheticDocuments } from '../documents/catalog.js';
import { ingestSyntheticCatalog } from '../documents/ingestion.js';
import { answerWithSelfCorrection } from './self-correcting-answer.js';
import { lexicalEvidenceRetriever, type ClientRunner } from './document-evidence.js';
import { abstentionCases } from './abstention-cases.js';
import { scoreAbstentionCases, type CaseOutcome } from './abstention-evaluation.js';

// Real PostgreSQL. Labelled development evaluation of the answer loop over lexical retrieval.
// The generator is a deterministic stub that cites the top evidence, so this measures retrieval-gated answer and
// abstention decisions. It makes no claim about generated text quality.
const adminUrl = process.env.TEST_DATABASE_ADMIN_URL;
const runtimeUrl = process.env.TEST_DATABASE_URL;
const ingestionUrl = process.env.TEST_DOCUMENT_INGEST_URL;
const runtimePassword = process.env.DATABASE_APP_PASSWORD;
const ingestionPassword = process.env.DATABASE_INGEST_PASSWORD;
if (!adminUrl || !runtimeUrl || !ingestionUrl || !runtimePassword || !ingestionPassword) {
  throw new Error('Set the isolated PostgreSQL test URLs and role passwords for real PostgreSQL tests.');
}

const north = resolveFixture('north');
const issuer = 'https://synthetic-eval.integration.example/';
const prefix = `eval-${randomUUID()}`;
const readerSubject = `${prefix}|north`;
const admin = new Pool({ connectionString: adminUrl, max: 1 });
const runtime = createDatabasePool(runtimeUrl, 2);
const ingestion = new Pool({ connectionString: ingestionUrl, max: 1 });
const principal: VerifiedPrincipal = { issuer, subject: readerSubject, scopes: new Set(['read:cases']) };
const run: ClientRunner = (operation) => withAuthenticatedTransaction(runtime, principal, north.tenantId, 'read:cases', operation);
const retriever = lexicalEvidenceRetriever(run, north.tenantId);

beforeAll(async () => {
  await migrateDatabase(adminUrl, runtimePassword, ingestionPassword);
  await admin.query('INSERT INTO aegis.memberships (issuer,subject,tenant_id,role) VALUES ($1,$2,$3,$4)', [issuer, readerSubject, north.tenantId, 'reader']);
  await ingestSyntheticCatalog(ingestion);
}, 30000);

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

describe('labelled abstention evaluation of the answer loop', () => {
  it('runs every labelled case through real retrieval and reports the decisions', async () => {
    const outcomes: CaseOutcome[] = [];
    for (const labelled of abstentionCases) {
      const result = await answerWithSelfCorrection(labelled.question, {
        retrieve: retriever,
        generate: async ({ evidence }) => `Based on the synthetic document [${evidence[0]!.sourceId}].`,
        reformulate: async () => null,
      }, { maxRounds: 2, minScore: 0.015, forbiddenSubstrings: ['SENTINEL-XYZ'] });
      outcomes.push(result.status === 'answered'
        ? { status: 'answered', citations: result.citations }
        : { status: 'abstained' });
    }
    const report = scoreAbstentionCases(abstentionCases, outcomes);
    const detail = abstentionCases.map((labelled, index) => ({ id: labelled.id, expected: labelled.expected, outcome: outcomes[index] }));
    // The report goes to a file named by C4_EVAL_OUTPUT, because vitest hides console output in this configuration.
    if (process.env.C4_EVAL_OUTPUT) writeFileSync(process.env.C4_EVAL_OUTPUT, `${JSON.stringify({ report, detail }, null, 2)}\n`);
    expect(report.total).toBe(abstentionCases.length);
    expect(report.answerable + report.unanswerable).toBe(abstentionCases.length);
  });
});

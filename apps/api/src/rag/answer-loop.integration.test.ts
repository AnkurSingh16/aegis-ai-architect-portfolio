import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { createDatabasePool } from '../storage/database.js';
import { migrateDatabase } from '../storage/migrations.js';
import { resolveFixture } from '../storage/config.js';
import { withAuthenticatedTransaction } from '../auth/transaction.js';
import type { VerifiedPrincipal } from '../auth/token.js';
import { syntheticDocuments } from '../documents/catalog.js';
import { ingestSyntheticCatalog } from '../documents/ingestion.js';
import { answerWithSelfCorrection, type GenerateInput } from './self-correcting-answer.js';
import { lexicalEvidenceRetriever, type ClientRunner } from './document-evidence.js';

// Real PostgreSQL: the self-correcting loop over tenant-scoped lexical retrieval, with a deterministic stub generator.
const adminUrl = process.env.TEST_DATABASE_ADMIN_URL;
const runtimeUrl = process.env.TEST_DATABASE_URL;
const ingestionUrl = process.env.TEST_DOCUMENT_INGEST_URL;
const runtimePassword = process.env.DATABASE_APP_PASSWORD;
const ingestionPassword = process.env.DATABASE_INGEST_PASSWORD;
if (!adminUrl || !runtimeUrl || !ingestionUrl || !runtimePassword || !ingestionPassword) {
  throw new Error('Set the isolated PostgreSQL test URLs and role passwords for real PostgreSQL tests.');
}

const north = resolveFixture('north');
const issuer = 'https://synthetic-rag.integration.example/';
const prefix = `rag-${randomUUID()}`;
const northSubject = `${prefix}|north`;
const admin = new Pool({ connectionString: adminUrl, max: 1 });
const runtime = createDatabasePool(runtimeUrl, 2);
const ingestion = new Pool({ connectionString: ingestionUrl, max: 1 });
const principal = (subject: string): VerifiedPrincipal => ({ issuer, subject, scopes: new Set(['read:cases']) });
const run: ClientRunner = (operation) =>
  withAuthenticatedTransaction(runtime, principal(northSubject), north.tenantId, 'read:cases', operation);
const retriever = lexicalEvidenceRetriever(run, north.tenantId);
const policy = { maxRounds: 2, minScore: 0.015, forbiddenSubstrings: ['SENTINEL-XYZ'] };

beforeAll(async () => {
  await migrateDatabase(adminUrl, runtimePassword, ingestionPassword);
  await admin.query('INSERT INTO aegis.memberships (issuer,subject,tenant_id,role) VALUES ($1,$2,$3,$4)', [issuer, northSubject, north.tenantId, 'reader']);
  await ingestSyntheticCatalog(ingestion);
}, 30000);

afterAll(async () => {
  // Remove the rows this file wrote, so later integration files in the same database see only their own data.
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

describe('self-correcting answer over tenant-scoped retrieval', () => {
  it('answers with citations that all name the caller tenant documents', async () => {
    const generate = async ({ evidence }: GenerateInput) => `Follow the checklist [${evidence[0]!.sourceId}].`;
    const result = await answerWithSelfCorrection('user-visible error', {
      retrieve: retriever, generate, reformulate: async () => null,
    }, policy);
    expect(result.status).toBe('answered');
    if (result.status !== 'answered') return;
    expect(result.citations.length).toBeGreaterThan(0);
    expect(result.citations.every((id) => id.startsWith('SYNTHETIC-NORTH-'))).toBe(true);
  });

  it('abstains without generating when the question only matches another tenant', async () => {
    let generated = false;
    const result = await answerWithSelfCorrection('invoice discrepancy', {
      retrieve: retriever,
      generate: async () => { generated = true; return 'never'; },
      reformulate: async () => null,
    }, policy);
    expect(result).toMatchObject({ status: 'abstained', reason: 'insufficient_evidence', rounds: 1 });
    expect(generated).toBe(false);
  });

  it('treats an invalid reformulated query as no evidence and abstains', async () => {
    const result = await answerWithSelfCorrection('user-visible error', {
      retrieve: retriever,
      generate: async () => 'Unsupported claim [SYNTHETIC-NORTH-UNKNOWN].',
      reformulate: async () => 'word '.repeat(60), // 300 characters: above the retrieval limit, within the loop's limit
    }, policy);
    expect(result).toMatchObject({ status: 'abstained', reason: 'insufficient_evidence', rounds: 2 });
  });
});

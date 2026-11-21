import { randomUUID } from 'node:crypto';
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
import { EMBEDDING_DIMENSIONS } from './ollama-embeddings.js';
import { retrieveByVector, storeChunkEmbeddings } from './vector-retrieval.js';

// C2 deterministic check of the vector path. The embeddings are SEEDED SYNTHETIC VECTORS, not model output: no model is run.
// The question is whether the database ranking (pgvector cosine distance, tenant scoped) equals an independent in-memory cosine
// ranking over the same vectors. That is the property the earlier measurements assumed without checking.

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
const issuer = 'https://vector-equivalence.integration.example/';
const prefix = `vector-${randomUUID()}`;
const subject = `${prefix}|reader`;
const admin = new Pool({ connectionString: adminUrl, max: 1 });
const runtime = createDatabasePool(runtimeUrl, 2);
const ingestion = new Pool({ connectionString: ingestionUrl, max: 1 });
const principal: VerifiedPrincipal = { issuer, subject, scopes: new Set(['read:cases']) };
// Writing embeddings needs the operator role, as in the generator evaluation.
const operatorSubject = `${prefix}|operator`;
const operator: VerifiedPrincipal = { issuer, subject: operatorSubject, scopes: new Set(['read:cases', 'write:cases']) };

/** Seeded, deterministic synthetic vectors (mulberry32). Not model output. */
function seededVector(seed: number): number[] {
  let state = seed >>> 0;
  const next = () => { state = (state + 0x6d2b79f5) >>> 0; let t = state; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296 - 0.5; };
  return Array.from({ length: EMBEDDING_DIMENSIONS }, next);
}
const cosine = (a: readonly number[], b: readonly number[]): number => {
  let dot = 0; let na = 0; let nb = 0;
  for (let i = 0; i < a.length; i += 1) { dot += a[i]! * b[i]!; na += a[i]! * a[i]!; nb += b[i]! * b[i]!; }
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
};

let chunkRows: { id: string; tenant_id: string; source_identity: string; content: string }[] = [];
let vectors = new Map<string, number[]>();

beforeAll(async () => {
  await migrateDatabase(adminUrl, runtimePassword, ingestionPassword);
  await admin.query('INSERT INTO aegis.memberships (issuer,subject,tenant_id,role) VALUES ($1,$2,$3,$4)', [issuer, subject, north.tenantId, 'reader']);
  await admin.query('INSERT INTO aegis.memberships (issuer,subject,tenant_id,role) VALUES ($1,$2,$3,$4)', [issuer, operatorSubject, north.tenantId, 'operator']);
  await admin.query('INSERT INTO aegis.memberships (issuer,subject,tenant_id,role) VALUES ($1,$2,$3,$4)', [issuer, operatorSubject, south.tenantId, 'operator']);
  await ingestSyntheticCatalog(ingestion);
  chunkRows = (await admin.query<typeof chunkRows[number]>(
    'SELECT id, tenant_id, source_identity, content FROM aegis.document_chunks WHERE tenant_id = ANY($1::uuid[]) AND document_version = 1 ORDER BY tenant_id, source_identity, position',
    [[north.tenantId, south.tenantId]])).rows;
  chunkRows.forEach((row, index) => vectors.set(row.id, seededVector(1000 + index)));
  for (const tenantId of [north.tenantId, south.tenantId]) {
    const rows = chunkRows.filter((r) => r.tenant_id === tenantId).map((r) => ({ chunkId: r.id, vector: vectors.get(r.id)! }));
    await withAuthenticatedTransaction(runtime, operator, tenantId, 'write:cases',
      (client) => storeChunkEmbeddings(client as unknown as TenantQueryable, tenantId, rows));
  }
}, 120000);

afterAll(async () => {
  const tenants = [north.tenantId, south.tenantId];
  const identities = syntheticDocuments.map((document) => document.sourceIdentity);
  try {
    await admin.query(`DELETE FROM aegis.chunk_embeddings WHERE chunk_id IN (
      SELECT id FROM aegis.document_chunks WHERE tenant_id = ANY($1::uuid[]) AND source_identity = ANY($2::text[]))`, [tenants, identities]);
    await admin.query('DELETE FROM aegis.memberships WHERE issuer=$1 AND subject LIKE $2', [issuer, `${prefix}|%`]);
  } finally { await Promise.all([admin.end(), runtime.end(), ingestion.end()]); }
});

describe('pgvector ranking equals an independent cosine ranking over the same synthetic vectors', () => {
  it('returns the same top-k order and similarities as an in-memory cosine ranking, for several queries', async () => {
    const tenantRows = chunkRows.filter((r) => r.tenant_id === north.tenantId);
    for (const seed of [7, 42, 99]) {
      const query = seededVector(seed);
      const expected = tenantRows
        .map((r) => ({ id: r.id, similarity: cosine(query, vectors.get(r.id)!) }))
        .sort((a, b) => b.similarity - a.similarity || (a.id < b.id ? -1 : 1))
        .slice(0, 5);
      const actual = await withAuthenticatedTransaction(runtime, principal, north.tenantId, 'read:cases',
        (client) => retrieveByVector(client as unknown as TenantQueryable, north.tenantId, query, 5));
      expect(actual.map((h) => h.chunkId)).toEqual(expected.map((e) => e.id));
      actual.forEach((hit, i) => expect(Math.abs(hit.similarity - expected[i]!.similarity)).toBeLessThan(1e-6));
    }
  });

  it('never returns another tenant\'s chunks, even for the same query vector', async () => {
    const query = seededVector(7);
    const hits = await withAuthenticatedTransaction(runtime, principal, north.tenantId, 'read:cases',
      (client) => retrieveByVector(client as unknown as TenantQueryable, north.tenantId, query, 20));
    const southIds = new Set(chunkRows.filter((r) => r.tenant_id === south.tenantId).map((r) => r.id));
    expect(hits.some((h) => southIds.has(h.chunkId))).toBe(false);
    expect(hits.every((h) => h.sourceIdentity.startsWith('SYNTHETIC-NORTH-'))).toBe(true);
  });

  it('respects topK exactly and rejects out-of-range topK before querying', async () => {
    const query = seededVector(3);
    const hits = await withAuthenticatedTransaction(runtime, principal, north.tenantId, 'read:cases',
      (client) => retrieveByVector(client as unknown as TenantQueryable, north.tenantId, query, 3));
    expect(hits).toHaveLength(3);
    await expect(withAuthenticatedTransaction(runtime, principal, north.tenantId, 'read:cases',
      (client) => retrieveByVector(client as unknown as TenantQueryable, north.tenantId, query, 21))).rejects.toThrow(RangeError);
  });
});

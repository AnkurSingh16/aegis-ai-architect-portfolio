import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { Pool, PoolClient } from 'pg';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { syntheticDocuments, chunkSyntheticDocument, maxChunkBytes, validateSyntheticCatalog } from './catalog.js';
import { approvedLocalPostgresSystemIdentifier, ingestSyntheticCatalog, ingestSyntheticCatalogLocal, parseDesktopPostgresInspect,
  validateIngestionArgs, validateIngestionConnection, validateLocalAdminConnection, validateLocalIngestionConnection,
  validateLocalIngestionOptIn, verifyLocalIngestionTarget } from './ingestion.js';
import { normalizeRetrievalQuery, retrieveDocumentChunks, retrievalLimits } from './retrieval.js';
import { retrievalEvaluationCases, scoreRetrieval } from './evaluation.js';

const digest = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');

describe('versioned synthetic document corpus', () => {
  it('contains only stable, invented and validated North/South source documents', () => {
    validateSyntheticCatalog();
    expect(syntheticDocuments).toHaveLength(8);
    expect(new Set(syntheticDocuments.map((item) => item.tenant))).toEqual(new Set(['north', 'south']));
    for (const document of syntheticDocuments) {
      expect(document.sourceIdentity).toMatch(/^SYNTHETIC-/);
      expect(document.contentSha256).toBe(digest(document.content));
      expect(document.sourceRevision).toBe('aegis-support-docs-v1');
      expect(document.content).not.toMatch(/password\s*[:=]|api[_ -]?key\s*[:=]|bearer\s+[a-z0-9._-]{16,}/i);
    }
  });
  it('keeps database ingestion manifests byte-aligned with catalog documents and chunks', async () => {
    const sql = await readFile(new URL('../../db/migrations/004_synthetic_document_ingestion.sql', import.meta.url), 'utf8');
    expect(sql).toContain('LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog');
    expect(sql).toContain('CREATE CONSTRAINT TRIGGER documents_require_complete_synthetic_chunks');
    expect(sql).toContain('DEFERRABLE INITIALLY DEFERRED');
    expect(sql).toContain('REVOKE ALL ON FUNCTION aegis_migrations.require_complete_synthetic_document() FROM PUBLIC');
    expect(sql).not.toContain('SECURITY DEFINER');
    expect(sql).not.toContain('ALTER FUNCTION aegis_migrations.require_complete_synthetic_document() OWNER TO aegis_ingest');
    for (const document of syntheticDocuments) {
      const tenantId = document.tenant === 'north' ? '10000000-0000-4000-8000-000000000001' : '20000000-0000-4000-8000-000000000002';
      expect(sql).toContain(`('${tenantId}'::uuid,'${document.sourceIdentity}',1,'${document.sourceRevision}','${document.contentSha256}','${JSON.stringify(document.metadata)}'::jsonb)`);
      const onlyChunk = chunkSyntheticDocument(document.content);
      expect(onlyChunk).toHaveLength(1);
      expect(sql).toContain(`('${tenantId}'::uuid,'${document.sourceIdentity}',1,${onlyChunk[0].position},'${onlyChunk[0].contentSha256}')`);
    }
  });
  it('rejects duplicated identities and changed content hashes before database access', () => {
    const first = syntheticDocuments[0];
    expect(() => validateSyntheticCatalog([first, first])).toThrow('invalid');
    expect(() => validateSyntheticCatalog([{ ...first, content: `${first.content} changed` }])).toThrow('invalid');
    expect(() => validateSyntheticCatalog([{ ...first, sourceIdentity: 'CUSTOMER-DOCUMENT' }])).toThrow('invalid');
    expect(() => validateSyntheticCatalog([{ ...first, tenant: 'south' }])).toThrow('invalid');
  });
  it('chunks Unicode only at code-point boundaries and preserves exact canonical text and hashes', () => {
    const text = `${'A'.repeat(1799)}🙂é終わり`;
    const canonical = text.normalize('NFC');
    const chunks = chunkSyntheticDocument(canonical);
    expect(chunks.map((chunk) => chunk.content).join('')).toBe(canonical);
    expect(chunks.every((chunk, index) => chunk.position === index && Buffer.byteLength(chunk.content, 'utf8') <= maxChunkBytes &&
      chunk.contentSha256 === digest(chunk.content))).toBe(true);
  });
  it('rejects noncanonical Unicode and documents larger than the reviewed bound', () => {
    expect(() => chunkSyntheticDocument('e\u0301')).toThrow('invalid');
    expect(() => chunkSyntheticDocument('x'.repeat(32 * 1024 + 1))).toThrow('invalid');
  });
});

describe('protected synthetic ingestion command and transaction', () => {
  afterEach(() => vi.restoreAllMocks());
  const safeIngestIdentity = { database: 'aegis_test', role: 'aegis_ingest', canLogin: true, superuser: false, bypassRls: false,
    createRole: false, createDb: false, inherit: false, replication: false, member: false, schemaCreate: false,
    publicCreate: false, migrationSchemaCreate: false, docUpdate: false, docDelete: false, docTruncate: false,
    chunkUpdate: false, chunkDelete: false, chunkTruncate: false, docSelect: true, docInsert: true,
    chunkSelect: true, chunkInsert: true, docOther: false, chunkOther: false, docColumnAcl: false, chunkColumnAcl: false,
    docPublicAcl: false, chunkPublicAcl: false, otherTablePrivileges: false };
  it('defaults to dry run and accepts only the exact apply argument', () => {
    expect(validateIngestionArgs([])).toBe(false);
    expect(validateIngestionArgs(['--apply'])).toBe(true);
    expect(validateIngestionArgs(['--apply-local'])).toBe('local');
    for (const args of [['--dry-run'], ['--apply', '--force'], ['--tenant', 'south']]) expect(() => validateIngestionArgs(args)).toThrow();
  });
  it('requires loopback aegis_test and the separate restricted ingestion identity', () => {
    expect(validateIngestionConnection('postgres://aegis_ingest:synthetic-only@127.0.0.1:5432/aegis_test').pathname).toBe('/aegis_test');
    for (const url of ['postgres://aegis_app:secret@127.0.0.1:5432/aegis_test',
      'postgres://aegis_ingest:secret@127.0.0.1:5432/aegis_local', 'postgres://aegis_ingest:secret@remote.invalid/aegis_test']) {
      expect(() => validateIngestionConnection(url)).toThrow('failed');
    }
  });
  it('keeps the local target separate, tightly binds its URL, and requires an explicit opt-in', () => {
    const local = 'postgres://aegis_ingest:private-only@127.0.0.1:5432/aegis_local';
    const localUrl = validateLocalIngestionConnection(local);
    expect(localUrl.pathname).toBe('/aegis_local');
    expect(validateLocalAdminConnection('postgres://aegis_local:private-only@127.0.0.1:5432/aegis_local', localUrl).username).toBe('aegis_local');
    validateLocalIngestionOptIn({ AEGIS_LOCAL_DOCUMENT_INGEST_ENABLED: 'true' });
    expect(() => validateLocalIngestionOptIn({ AEGIS_LOCAL_DOCUMENT_INGEST_ENABLED: 'false' })).toThrow();
    for (const url of [
      'postgres://aegis_ingest:private-only@127.0.0.1:5432/aegis_test',
      'postgres://aegis_ingest:private-only@localhost:5432/aegis_local',
      'postgres://aegis_ingest:private-only@127.0.0.1:5433/aegis_local',
      'postgres://aegis_app:private-only@127.0.0.1:5432/aegis_local',
    ]) expect(() => validateLocalIngestionConnection(url)).toThrow();
    for (const url of ['postgres://aegis_ingest:private-only@127.0.0.1:5432/aegis_local',
      'postgres://aegis_app:private-only@127.0.0.1:5432/aegis_local']) {
      expect(() => validateLocalAdminConnection(url, localUrl)).toThrow();
    }
    expect(approvedLocalPostgresSystemIdentifier).toBe('7701292369980424230');
  });
  it('accepts only a healthy Docker Desktop Postgres container with an exact loopback port mapping', () => {
    const inspect = [{ Name: '/aegis-ai-portfolio-git-postgres-1', State: { Running: true, Health: { Status: 'healthy' } },
      NetworkSettings: { Ports: { '5432/tcp': [{ HostIp: '127.0.0.1', HostPort: '5432' }] },
        Networks: { aegis: { IPAddress: '172.19.0.2' } } } }];
    expect(parseDesktopPostgresInspect(inspect).containerIpAddresses).toEqual(['172.19.0.2']);
    for (const changed of [
      [{ ...inspect[0], State: { Running: false, Health: { Status: 'healthy' } } }],
      [{ ...inspect[0], State: { Running: true, Health: { Status: 'unhealthy' } } }],
      [{ ...inspect[0], NetworkSettings: { ...inspect[0].NetworkSettings,
        Ports: { '5432/tcp': [{ HostIp: '0.0.0.0', HostPort: '5432' }] } } }],
      [{ ...inspect[0], NetworkSettings: { ...inspect[0].NetworkSettings,
        Ports: { '5432/tcp': [{ HostIp: '127.0.0.1', HostPort: '5432' }, { HostIp: '0.0.0.0', HostPort: '5432' }] } } }],
      [{ ...inspect[0], NetworkSettings: { ...inspect[0].NetworkSettings,
        Ports: { '5432/tcp': [{ HostIp: '127.0.0.1', HostPort: '5433' }] } } }],
      [{ ...inspect[0], Name: '/unexpected-container' }],
    ]) expect(() => parseDesktopPostgresInspect(changed)).toThrow();
  });
  it('verifies local database identity read-only and refuses mismatched cluster/network evidence', async () => {
    const localUrl = validateLocalIngestionConnection('postgres://aegis_ingest:p@127.0.0.1:5432/aegis_local');
    const adminUrl = validateLocalAdminConnection('postgres://aegis_local:p@127.0.0.1:5432/aegis_local', localUrl);
    const evidence = { containerIpAddresses: ['172.19.0.2'] };
    const identity = { database: 'aegis_local', role: 'aegis_local', serverAddress: '172.19.0.2', serverPort: 5432,
      systemIdentifier: approvedLocalPostgresSystemIdentifier };
    const query = vi.fn(async (sql: string) => sql === 'BEGIN READ ONLY' || sql === 'ROLLBACK' ? { rows: [] } : { rows: [identity] });
    const client = { query, release: vi.fn() } as unknown as PoolClient;
    const pool = { connect: vi.fn().mockResolvedValue(client) } as unknown as Pool;
    await expect(verifyLocalIngestionTarget(pool, adminUrl, localUrl, evidence)).resolves.toBe('172.19.0.2');
    expect(query).toHaveBeenNthCalledWith(1, 'BEGIN READ ONLY');
    expect(query).toHaveBeenLastCalledWith('ROLLBACK');
    for (const mismatch of [{ ...identity, database: 'aegis_test' }, { ...identity, role: 'aegis_ingest' },
      { ...identity, systemIdentifier: '7701562929516937253' }, { ...identity, serverAddress: '172.19.0.99' },
      { ...identity, serverPort: 5433 }]) {
      const mismatchQuery = vi.fn(async (sql: string) => sql === 'BEGIN READ ONLY' || sql === 'ROLLBACK' ? { rows: [] } : { rows: [mismatch] });
      const mismatchClient = { query: mismatchQuery, release: vi.fn() } as unknown as PoolClient;
      await expect(verifyLocalIngestionTarget({ connect: vi.fn().mockResolvedValue(mismatchClient) } as unknown as Pool,
        adminUrl, localUrl, evidence)).rejects.toMatchObject({ code: 'unsafe_target' });
      expect(mismatchQuery).not.toHaveBeenCalledWith('BEGIN');
      expect(mismatchQuery).toHaveBeenCalledWith('BEGIN READ ONLY');
      expect(mismatchQuery).toHaveBeenCalledWith('ROLLBACK');
    }
  });
  it('writes one catalog transaction with parameterized statements and no update/delete fallback', async () => {
    const id = randomUUID();
    const query = vi.fn(async (sql: string, parameters?: unknown[]) => {
      void parameters;
      if (sql.includes('current_database()')) return { rows: [safeIngestIdentity] };
      if (sql.includes('FROM aegis.documents WHERE')) return { rows: [] };
      if (sql.includes('INSERT INTO aegis.documents')) return { rows: [{ id }] };
      return { rows: [] };
    });
    const client = { query, release: vi.fn() } as unknown as PoolClient;
    const pool = { connect: vi.fn().mockResolvedValue(client) } as unknown as Pool;
    const summary = await ingestSyntheticCatalog(pool, [syntheticDocuments[0]]);
    expect(summary.documentsInserted).toBe(1);
    expect(summary.documentsUnchanged).toBe(0);
    expect(summary.chunksInserted).toBeGreaterThan(0);
    expect(query).toHaveBeenCalledWith('BEGIN');
    expect(query).toHaveBeenCalledWith('COMMIT');
    expect(query.mock.calls.some(([sql]) => /^\s*(?:UPDATE|DELETE|TRUNCATE)\s+|ON CONFLICT/i.test(sql))).toBe(false);
    expect(query.mock.calls.some(([sql]) => sql.includes('INSERT INTO aegis.document_chunks'))).toBe(true);
    expect(client.release).toHaveBeenCalledOnce();
  });
  it('rejects a conflicting existing version and rolls back without replacing it', async () => {
    const query = vi.fn(async (sql: string, parameters?: unknown[]) => {
      void parameters;
      if (sql.includes('current_database()')) return { rows: [safeIngestIdentity] };
      if (sql.includes('FROM aegis.documents WHERE')) return { rows: [{ id: randomUUID(), source_owner: 'unexpected',
        ingestion_source: 'source-controlled-synthetic-catalog', ingestion_revision: 'aegis-support-docs-v1',
        content_sha256: syntheticDocuments[0].contentSha256, metadata: syntheticDocuments[0].metadata }] };
      return { rows: [] };
    });
    const client = { query, release: vi.fn() } as unknown as PoolClient;
    await expect(ingestSyntheticCatalog({ connect: vi.fn().mockResolvedValue(client) } as unknown as Pool, [syntheticDocuments[0]]))
      .rejects.toMatchObject({ code: 'catalog_conflict' });
    expect(query).toHaveBeenCalledWith('ROLLBACK');
    expect(query.mock.calls.some(([sql]) => String(sql).includes('INSERT INTO'))).toBe(false);
  });
  it('rejects unsafe targets and role privileges before beginning a write transaction', async () => {
    for (const identity of [
      { ...safeIngestIdentity, database: 'aegis_local' },
      { ...safeIngestIdentity, bypassRls: true },
      { ...safeIngestIdentity, migrationSchemaCreate: true },
      { ...safeIngestIdentity, member: true },
      { ...safeIngestIdentity, docPublicAcl: true },
      { ...safeIngestIdentity, otherTablePrivileges: true },
    ]) {
      const query = vi.fn().mockResolvedValue({ rows: [identity] });
      const client = { query, release: vi.fn() } as unknown as PoolClient;
      await expect(ingestSyntheticCatalog({ connect: vi.fn().mockResolvedValue(client) } as unknown as Pool, [syntheticDocuments[0]])).rejects.toThrow();
      expect(query.mock.calls.some(([sql]) => sql === 'BEGIN')).toBe(false);
    }
  });
  it('keeps the local writer separate and refuses an aegis_test connection before writes', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ ...safeIngestIdentity, database: 'aegis_test' }] });
    const client = { query, release: vi.fn() } as unknown as PoolClient;
    await expect(ingestSyntheticCatalogLocal({ connect: vi.fn().mockResolvedValue(client) } as unknown as Pool,
      '172.19.0.2', [syntheticDocuments[0]])).rejects.toMatchObject({ code: 'unsafe_target' });
    expect(query).not.toHaveBeenCalledWith('BEGIN');
    expect(query.mock.calls.some(([sql]) => /^(?:INSERT|UPDATE|DELETE|TRUNCATE)\b/i.test(String(sql)))).toBe(false);
  });
  it('rejects a local writer whose server endpoint changed after the read-only cluster preflight', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ ...safeIngestIdentity, database: 'aegis_local',
      serverAddress: '172.19.0.99', serverPort: 5432 }] });
    const client = { query, release: vi.fn() } as unknown as PoolClient;
    await expect(ingestSyntheticCatalogLocal({ connect: vi.fn().mockResolvedValue(client) } as unknown as Pool,
      '172.19.0.2', [syntheticDocuments[0]])).rejects.toMatchObject({ code: 'unsafe_target' });
    expect(query).not.toHaveBeenCalledWith('BEGIN');
    expect(query.mock.calls.some(([sql]) => /^(?:INSERT|UPDATE|DELETE|TRUNCATE)\b/i.test(String(sql)))).toBe(false);
  });
});

describe('bounded full-text retrieval input contract', () => {
  it('normalizes consistently and enforces character, byte and control bounds', () => {
    expect(normalizeRetrievalQuery('  Login\t MFA  ')).toBe('Login MFA');
    expect(normalizeRetrievalQuery('café')).toBe('café');
    expect(() => normalizeRetrievalQuery('')).toThrow();
    expect(() => normalizeRetrievalQuery('🙂'.repeat(retrievalLimits.maxQueryCharacters + 1))).toThrow();
    expect(() => normalizeRetrievalQuery('\u0000')).toThrow();
  });
  it('uses fixed English FTS, tenant filter, stable tie breaks and bounded result handling', async () => {
    const query = vi.fn(async (sql: string, parameters?: unknown[]) => {
      void parameters;
      return sql.includes('WITH parsed') ? { rows: [
      { chunk_id: randomUUID(), source_identity: 'SYNTHETIC-NORTH-LOGIN', document_version: 1, position: 0, title: 'Synthetic login',
        content: 'Local login failed.', rank: 0.5 },
    ] } : { rows: [] };
    });
    const results = await retrieveDocumentChunks({ query } as unknown as PoolClient, '10000000-0000-4000-8000-000000000001', 'login');
    expect(results).toHaveLength(1);
    expect(query.mock.calls[0][0]).toContain('statement_timeout');
    expect(query.mock.calls[1][0]).toContain("plainto_tsquery('english'::regconfig");
    expect(query.mock.calls[1][0]).toContain('rank DESC,source_identity ASC,document_version DESC,position ASC,chunk_id ASC');
    expect(query.mock.calls[1][0]).toContain('c.tenant_id=$2');
    expect(query.mock.calls[1][1]).toEqual(['login', '10000000-0000-4000-8000-000000000001', retrievalLimits.minimumRank, retrievalLimits.maxTopK]);
  });
  it('fails closed on retrieval query errors and never exposes database details', async () => {
    const query = vi.fn().mockRejectedValue(new Error('private document query detail'));
    await expect(retrieveDocumentChunks({ query } as unknown as PoolClient, 'tenant', 'login')).rejects.toMatchObject({ code: 'unavailable' });
  });
});

describe('deterministic retrieval evaluation rubric', () => {
  it('reports explicit recall, precision and ranking denominators for predeclared synthetic labels', () => {
    const observations = retrievalEvaluationCases.map((item) => ({ caseId: item.id, retrievedSourceIdentities: [...item.relevantSources] }));
    expect(scoreRetrieval(observations)).toMatchObject({ datasetVersion: 'aegis-synthetic-doc-retrieval-v1', queries: 8,
      recallAtK: { numerator: 8, denominator: 8, rate: 1 }, precisionAtK: { numerator: 8, denominator: 8, rate: 1 } });
    expect(scoreRetrieval([])).toMatchObject({ recallAtK: { numerator: 0, denominator: 8 }, precisionAtK: { numerator: 0, denominator: 0 } });
    const duplicate = scoreRetrieval([{ caseId: 'login-triage', retrievedSourceIdentities: [
      'SYNTHETIC-NORTH-LOGIN-INCIDENT', 'SYNTHETIC-NORTH-LOGIN-INCIDENT', 'SYNTHETIC-NORTH-MFA-GUIDANCE',
    ] }]);
    expect(duplicate.recallAtK).toMatchObject({ numerator: 1, denominator: 8 });
    expect(duplicate.precisionAtK).toMatchObject({ numerator: 1, denominator: 2 });
    const repeatedChunks = scoreRetrieval([{ caseId: 'login-triage', retrievedSourceIdentities: [
      ...Array.from({ length: 6 }, () => 'SYNTHETIC-NORTH-MFA-GUIDANCE'), 'SYNTHETIC-NORTH-LOGIN-INCIDENT',
    ] }]);
    expect(repeatedChunks.recallAtK).toMatchObject({ numerator: 1, denominator: 8 });
    expect(repeatedChunks.meanReciprocalRank).toBe(1 / 16);
    expect(() => scoreRetrieval([], 0)).toThrow();
  });
});

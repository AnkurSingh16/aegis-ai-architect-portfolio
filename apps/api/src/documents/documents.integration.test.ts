import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { createDatabasePool, verifyRuntimeRole } from '../storage/database.js';
import { migrateDatabase } from '../storage/migrations.js';
import { resolveFixture } from '../storage/config.js';
import { withAuthenticatedTransaction } from '../auth/transaction.js';
import type { VerifiedPrincipal } from '../auth/token.js';
import { syntheticDocuments } from './catalog.js';
import { ingestSyntheticCatalog, ingestSyntheticCatalogLocal, validateIngestionConnection, validateLocalIngestionConnection } from './ingestion.js';
import { retrieveDocumentChunks } from './retrieval.js';
import { retrievalEvaluationCases, scoreRetrieval } from './evaluation.js';

const adminUrl = process.env.TEST_DATABASE_ADMIN_URL;
const runtimeUrl = process.env.TEST_DATABASE_URL;
const ingestionUrl = process.env.TEST_DOCUMENT_INGEST_URL;
const runtimePassword = process.env.DATABASE_APP_PASSWORD;
const ingestionPassword = process.env.DATABASE_INGEST_PASSWORD;
if (!adminUrl || !runtimeUrl || !ingestionUrl || !runtimePassword || !ingestionPassword) {
  throw new Error('Explicit isolated document integration configuration is required.');
}
const safeTestUrl = (value: string, username?: string): URL => {
  const url = new URL(value);
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
      url.pathname !== '/aegis_test' || url.search || url.hash || (username && url.username !== username)) {
    throw new Error('Document integration connections must target the isolated loopback aegis_test database.');
  }
  return url;
};
const adminParsed = safeTestUrl(adminUrl);
const runtimeParsed = safeTestUrl(runtimeUrl, 'aegis_app');
const ingestionParsed = safeTestUrl(ingestionUrl, 'aegis_ingest');
if (adminParsed.username === runtimeParsed.username || adminParsed.username === ingestionParsed.username ||
    runtimePassword.length < 16 || ingestionPassword.length < 16 || ingestionPassword === runtimePassword ||
    decodeURIComponent(runtimeParsed.password) !== runtimePassword || decodeURIComponent(ingestionParsed.password) !== ingestionPassword) {
  throw new Error('Document integration roles must use distinct least-privilege credentials.');
}

const north = resolveFixture('north');
const south = resolveFixture('south');
const issuer = 'https://synthetic-docs.integration.example/';
const prefix = `documents-${randomUUID()}`;
const northSubject = `${prefix}|north`;
const southSubject = `${prefix}|south`;
const admin = new Pool({ connectionString: adminUrl, max: 1 });
const runtime = createDatabasePool(runtimeUrl, 2);
const ingestion = new Pool({ connectionString: ingestionUrl, max: 1 });
const principal = (subject: string): VerifiedPrincipal => ({ issuer, subject, scopes: new Set(['read:cases']) });

beforeAll(async () => {
  await migrateDatabase(adminUrl, runtimePassword, ingestionPassword);
  await verifyRuntimeRole(runtime);
  await admin.query('INSERT INTO aegis.memberships (issuer,subject,tenant_id,role) VALUES ($1,$2,$3,$4),($1,$5,$6,$4)',
    [issuer, northSubject, north.tenantId, 'reader', southSubject, south.tenantId]);
  const result = await ingestSyntheticCatalog(ingestion);
  expect(result.documentsInserted + result.documentsUnchanged).toBe(syntheticDocuments.length);
}, 30000);

afterAll(async () => {
  try {
    await admin.query('DELETE FROM aegis.memberships WHERE issuer=$1 AND subject LIKE $2', [issuer, `${prefix}|%`]);
  } finally { await Promise.all([admin.end(), runtime.end(), ingestion.end()]); }
});

describe('isolated PostgreSQL tenant document boundary', () => {
  it('returns a canonical host address for inet values and the connected PostgreSQL server without changing data', async () => {
    const client = await admin.connect();
    try {
      await client.query('BEGIN READ ONLY');
      const result = await client.query<{ canonical: string; serverAddress: string | null; serverNetwork: string | null; serverPort: number }>(`
        SELECT host(inet '172.18.0.2/32') AS canonical,
          host(inet_server_addr()) AS "serverAddress",inet_server_addr()::text AS "serverNetwork",
          inet_server_port() AS "serverPort"`);
      const identity = result.rows[0];
      expect(identity?.canonical).toBe('172.18.0.2');
      expect(identity?.serverAddress).toBeTruthy();
      expect(identity?.serverNetwork).toBeTruthy();
      expect(identity?.serverPort).toBe(5432);
      expect(identity?.serverAddress).not.toContain('/');
      expect(await client.query('SELECT host($1::inet) AS address', [identity?.serverNetwork])).toMatchObject({
        rows: [{ address: identity?.serverAddress }],
      });
    } finally { await client.query('ROLLBACK').catch(() => {}); client.release(); }
  });

  it('refuses the isolated aegis_test target through the local writer before any transaction or data change', async () => {
    expect(() => validateLocalIngestionConnection(ingestionUrl)).toThrow();
    const before = await admin.query(`SELECT (SELECT count(*) FROM aegis.documents)::int AS documents,
      (SELECT count(*) FROM aegis.document_chunks)::int AS chunks`);
    await expect(ingestSyntheticCatalogLocal(ingestion, '127.0.0.1')).rejects.toMatchObject({ code: 'unsafe_target' });
    const after = await admin.query(`SELECT (SELECT count(*) FROM aegis.documents)::int AS documents,
      (SELECT count(*) FROM aegis.document_chunks)::int AS chunks`);
    expect(after.rows).toEqual(before.rows);
  });

  it('rejects an allowlisted parent without its complete chunk set at commit and then replays the full catalog', async () => {
    const document = syntheticDocuments[0];
    const tenantId = north.tenantId;
    await admin.query('DELETE FROM aegis.document_chunks WHERE tenant_id=$1 AND source_identity=$2 AND document_version=1',
      [tenantId, document.sourceIdentity]);
    await admin.query('DELETE FROM aegis.documents WHERE tenant_id=$1 AND source_identity=$2 AND version=1',
      [tenantId, document.sourceIdentity]);

    const client = await ingestion.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('aegis.access_mode','catalog_ingestion',true),set_config('aegis.tenant_id',$1,true)", [tenantId]);
      await client.query(`INSERT INTO aegis.documents
        (tenant_id,source_identity,version,source_owner,ingestion_source,ingestion_revision,content_sha256,metadata)
        VALUES ($1,$2,1,$3,'source-controlled-synthetic-catalog',$4,$5,$6::jsonb)`,
      [tenantId, document.sourceIdentity, document.sourceOwner, document.sourceRevision, document.contentSha256, JSON.stringify(document.metadata)]);
      await expect(client.query('COMMIT')).rejects.toMatchObject({ code: '23514' });
    } finally { await client.query('ROLLBACK').catch(() => {}); client.release(); }

    expect((await admin.query('SELECT id FROM aegis.documents WHERE tenant_id=$1 AND source_identity=$2 AND version=1',
      [tenantId, document.sourceIdentity])).rows).toEqual([]);
    await expect(ingestSyntheticCatalog(ingestion)).resolves.toMatchObject({ documentsInserted: 1, chunksInserted: 1 });
  });

  it('restricts catalog ingestion to its role, fixed source-to-tenant map and replay-safe source versions', async () => {
    expect(validateIngestionConnection(ingestionUrl).pathname).toBe('/aegis_test');
    const unchanged = await ingestSyntheticCatalog(ingestion);
    expect(unchanged).toMatchObject({ documentsInserted: 0, documentsUnchanged: syntheticDocuments.length, chunksInserted: 0 });
    const identity = (await ingestion.query(`SELECT r.rolcanlogin,r.rolsuper,r.rolbypassrls,r.rolcreatedb,r.rolcreaterole,r.rolinherit,
      EXISTS(SELECT 1 FROM pg_auth_members m WHERE m.member=r.oid OR m.roleid=r.oid) AS has_membership,
      has_schema_privilege(current_user,'aegis','CREATE') AS schema_create,
      has_schema_privilege(current_user,'aegis_migrations','CREATE') AS migration_schema_create,
      has_table_privilege(current_user,'aegis.documents','UPDATE') AS can_update,
      has_table_privilege(current_user,'aegis.documents','DELETE') AS can_delete,
      has_table_privilege(current_user,'aegis.documents','INSERT') AS can_insert,
      has_table_privilege(current_user,'aegis.document_chunks','INSERT') AS chunk_insert,
      EXISTS(SELECT 1 FROM pg_attribute a WHERE a.attrelid='aegis.documents'::regclass AND a.attnum>0 AND NOT a.attisdropped AND a.attacl IS NOT NULL) AS doc_column_acl,
      EXISTS(SELECT 1 FROM pg_attribute a WHERE a.attrelid='aegis.document_chunks'::regclass AND a.attnum>0 AND NOT a.attisdropped AND a.attacl IS NOT NULL) AS chunk_column_acl
      ,EXISTS(SELECT 1 FROM pg_class c,LATERAL aclexplode(COALESCE(c.relacl,acldefault('r',c.relowner))) x
        WHERE c.oid='aegis.documents'::regclass AND x.grantee=0) AS doc_public_acl
      ,EXISTS(SELECT 1 FROM pg_class c,LATERAL aclexplode(COALESCE(c.relacl,acldefault('r',c.relowner))) x
        WHERE c.oid='aegis.document_chunks'::regclass AND x.grantee=0) AS chunk_public_acl
      ,EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE c.relkind IN ('r','p','v','m') AND n.nspname NOT IN ('pg_catalog','information_schema')
          AND c.oid NOT IN ('aegis.documents'::regclass,'aegis.document_chunks'::regclass)
          AND has_table_privilege(current_user,c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')) AS other_table_privileges
      FROM pg_roles r WHERE r.rolname=current_user`)).rows[0];
    expect(identity).toEqual({ rolcanlogin: true, rolsuper: false, rolbypassrls: false, rolcreatedb: false, rolcreaterole: false,
      rolinherit: false, has_membership: false, schema_create: false, migration_schema_create: false,
      can_update: false, can_delete: false, can_insert: true, chunk_insert: true, doc_column_acl: false, chunk_column_acl: false,
      doc_public_acl: false, chunk_public_acl: false, other_table_privileges: false });
    const guard = (await admin.query(`SELECT p.prosecdef,pg_get_userbyid(p.proowner) AS owner
      FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='aegis_migrations' AND p.proname='require_complete_synthetic_document'`)).rows[0];
    expect(guard).toMatchObject({ prosecdef: false });
    expect(guard.owner).not.toBe('aegis_ingest');
    await expect(ingestion.query(`ALTER FUNCTION aegis_migrations.require_complete_synthetic_document()
      SET search_path = pg_catalog`)).rejects.toMatchObject({ code: '42501' });
    const wrongTenantClient = await ingestion.connect();
    try {
      await wrongTenantClient.query('BEGIN');
      await wrongTenantClient.query("SELECT set_config('aegis.access_mode','catalog_ingestion',true),set_config('aegis.tenant_id',$1,true)", [south.tenantId]);
      await expect(wrongTenantClient.query(`INSERT INTO aegis.documents
        (tenant_id,source_identity,version,source_owner,ingestion_source,ingestion_revision,content_sha256,metadata)
        VALUES ($1,$2,1,'Aegis synthetic corpus','source-controlled-synthetic-catalog','aegis-support-docs-v1',$3,'{}'::jsonb)`,
      [south.tenantId, syntheticDocuments[0].sourceIdentity, syntheticDocuments[0].contentSha256])).rejects.toMatchObject({ code: '42501' });
    } finally { await wrongTenantClient.query('ROLLBACK'); wrongTenantClient.release(); }

    const document = syntheticDocuments[0];
    const parent = await admin.query<{ id: string }>('SELECT id FROM aegis.documents WHERE tenant_id=$1 AND source_identity=$2 AND version=1',
      [north.tenantId, document.sourceIdentity]);
    expect(parent.rows).toHaveLength(1);
    const rejectsAsIngestion = async (sql: string, values: unknown[]) => {
      const client = await ingestion.connect();
      try {
        await client.query('BEGIN');
        await client.query("SELECT set_config('aegis.access_mode','catalog_ingestion',true),set_config('aegis.tenant_id',$1,true)", [north.tenantId]);
        await expect(client.query(sql, values)).rejects.toMatchObject({ code: '42501' });
      } finally { await client.query('ROLLBACK'); client.release(); }
    };
    const docInsert = `INSERT INTO aegis.documents
      (tenant_id,source_identity,version,source_owner,ingestion_source,ingestion_revision,content_sha256,metadata)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)`;
    const validDoc = [north.tenantId, document.sourceIdentity, 1, document.sourceOwner, 'source-controlled-synthetic-catalog',
      document.sourceRevision, document.contentSha256, JSON.stringify(document.metadata)];
    await rejectsAsIngestion(docInsert, [north.tenantId, document.sourceIdentity, 2, ...validDoc.slice(3)]);
    await rejectsAsIngestion(docInsert, [north.tenantId, document.sourceIdentity, 1, document.sourceOwner,
      'source-controlled-synthetic-catalog', document.sourceRevision, '0'.repeat(64), JSON.stringify(document.metadata)]);
    await rejectsAsIngestion(docInsert, [north.tenantId, document.sourceIdentity, 1, document.sourceOwner,
      'source-controlled-synthetic-catalog', document.sourceRevision, document.contentSha256,
      JSON.stringify({ ...document.metadata, title: 'unapproved altered title' })]);
    await rejectsAsIngestion(`INSERT INTO aegis.document_chunks
      (tenant_id,document_id,document_version,source_identity,position,content,content_sha256)
      VALUES ($1,$2,1,$3,0,$4,$5)`, [north.tenantId, parent.rows[0].id, document.sourceIdentity,
        'altered content with a matching self-computed digest', createHash('sha256').update('altered content with a matching self-computed digest').digest('hex')]);
  });

  it('retrieves North and South only with each verified membership and tenant transaction', async () => {
    const northResults = await withAuthenticatedTransaction(runtime, principal(northSubject), north.tenantId, 'read:cases',
      (client) => retrieveDocumentChunks(client, north.tenantId, 'user-visible error'));
    const southResults = await withAuthenticatedTransaction(runtime, principal(southSubject), south.tenantId, 'read:cases',
      (client) => retrieveDocumentChunks(client, south.tenantId, 'invoice discrepancy'));
    expect(northResults.length).toBeGreaterThan(0);
    expect(northResults.every((row) => row.sourceIdentity.startsWith('SYNTHETIC-NORTH-'))).toBe(true);
    expect(southResults.length).toBeGreaterThan(0);
    expect(southResults.every((row) => row.sourceIdentity.startsWith('SYNTHETIC-SOUTH-'))).toBe(true);
    await expect(withAuthenticatedTransaction(runtime, principal(northSubject), north.tenantId, 'read:cases',
      (client) => retrieveDocumentChunks(client, south.tenantId, 'invoice discrepancy'))).resolves.toEqual([]);
    await expect(withAuthenticatedTransaction(runtime, principal(`${prefix}|absent`), north.tenantId, 'read:cases',
      (client) => retrieveDocumentChunks(client, north.tenantId, 'login'))).rejects.toMatchObject({ status: 403 });
  });

  it('measures deterministic full-text relevance separately from model generation', async () => {
    const observations = [];
    for (const item of retrievalEvaluationCases) {
      const fixture = item.tenant === 'north' ? north : south;
      const subject = item.tenant === 'north' ? northSubject : southSubject;
      const rows = await withAuthenticatedTransaction(runtime, principal(subject), fixture.tenantId, 'read:cases',
        (client) => retrieveDocumentChunks(client, fixture.tenantId, item.query));
      expect(rows.every((row) => row.sourceIdentity.startsWith(`SYNTHETIC-${item.tenant.toUpperCase()}-`))).toBe(true);
      expect(rows.map((row) => row.sourceIdentity), `retrieval query ${item.id} must find its predeclared source`)
        .toContain(item.relevantSources[0]);
      observations.push({ caseId: item.id, retrievedSourceIdentities: rows.map((row) => row.sourceIdentity) });
    }
    const score = scoreRetrieval(observations);
    expect(score).toMatchObject({ datasetVersion: 'aegis-synthetic-doc-retrieval-v1', queries: retrievalEvaluationCases.length });
    expect(score.recallAtK).toEqual({ numerator: 8, denominator: 8, rate: 1 });
    expect(score.meanReciprocalRank).toBe(1);
    expect(score.precisionAtK.numerator).toBe(8);
    expect(score.precisionAtK.denominator).toBe(8);
  });

  it('returns no chunks for an irrelevant query so the HTTP path can abstain without generation', async () => {
    const rows = await withAuthenticatedTransaction(runtime, principal(northSubject), north.tenantId, 'read:cases',
      (client) => retrieveDocumentChunks(client, north.tenantId, 'volcano spacecraft'));
    expect(rows).toEqual([]);
  });

  it('denies tenant-GUC-only reads and all runtime document mutations', async () => {
    const client = await runtime.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('aegis.access_mode','authenticated',true),set_config('aegis.tenant_id',$1,true),
        set_config('aegis.principal_issuer','',true),set_config('aegis.principal_subject','',true)`, [north.tenantId]);
      expect((await client.query('SELECT id FROM aegis.documents')).rows).toEqual([]);
      await expect(client.query(`INSERT INTO aegis.documents
        (tenant_id,source_identity,version,source_owner,ingestion_source,ingestion_revision,content_sha256)
        VALUES ($1,'SYNTHETIC-NORTH-LOGIN-INCIDENT',99,'Aegis synthetic corpus','source-controlled-synthetic-catalog','test',$2)`,
      [north.tenantId, '0'.repeat(64)])).rejects.toMatchObject({ code: '42501' });
      await client.query('ROLLBACK');
    } finally { client.release(); }
    const statements = [
      `INSERT INTO aegis.documents (tenant_id,source_identity,version,source_owner,ingestion_source,ingestion_revision,content_sha256)
       VALUES ('${north.tenantId}','SYNTHETIC-NORTH-LOGIN-INCIDENT',99,'Aegis synthetic corpus','source-controlled-synthetic-catalog','test','${'0'.repeat(64)}')`,
      'UPDATE aegis.documents SET source_owner=source_owner', 'DELETE FROM aegis.documents WHERE true', 'TRUNCATE aegis.documents',
    ];
    for (const statement of statements) await expect(runtime.query(statement)).rejects.toMatchObject({ code: '42501' });
  });
});

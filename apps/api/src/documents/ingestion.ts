import type { Pool, PoolClient } from 'pg';
import { chunkSyntheticDocument, syntheticDocumentTenantId, syntheticIngestionSource, syntheticDocuments,
  syntheticSourceOwner, validateSyntheticCatalog, type SyntheticDocument } from './catalog.js';

export class DocumentIngestionError extends Error {
  constructor(readonly code: 'unsafe_target' | 'unsafe_role' | 'catalog_conflict' | 'database_failure') {
    super('Synthetic document ingestion failed.');
  }
}

export interface IngestionSummary { documentsInserted: number; documentsUnchanged: number; chunksInserted: number }

function sameDocument(row: Record<string, unknown>, document: SyntheticDocument): boolean {
  const metadata = row.metadata;
  const metadataMatches = typeof metadata === 'object' && metadata !== null && !Array.isArray(metadata) &&
    (metadata as Record<string, unknown>).title === document.title &&
    (metadata as Record<string, unknown>).contentType === 'text/plain' &&
    (metadata as Record<string, unknown>).sourceKind === 'synthetic_support_procedure' &&
    Object.keys(metadata).length === 3;
  return row.source_owner === syntheticSourceOwner && row.ingestion_source === syntheticIngestionSource &&
    row.ingestion_revision === document.sourceRevision && row.content_sha256 === document.contentSha256 &&
    metadataMatches;
}

async function ingestDocument(client: PoolClient, document: SyntheticDocument): Promise<{ inserted: boolean; chunks: number }> {
  const tenantId = syntheticDocumentTenantId(document);
  await client.query("SELECT set_config('aegis.tenant_id',$1,true)", [tenantId]);
  const existing = await client.query(`SELECT id,source_owner,ingestion_source,ingestion_revision,content_sha256,metadata
    FROM aegis.documents WHERE tenant_id=$1 AND source_identity=$2 AND version=$3`, [tenantId, document.sourceIdentity, document.version]);
  const chunks = chunkSyntheticDocument(document.content);
  if (existing.rows.length > 0) {
    const row = existing.rows[0] as Record<string, unknown>;
    if (existing.rows.length !== 1 || !sameDocument(row, document)) throw new DocumentIngestionError('catalog_conflict');
    const storedChunks = await client.query(`SELECT position,content,content_sha256 FROM aegis.document_chunks
      WHERE tenant_id=$1 AND document_id=$2 AND document_version=$3 ORDER BY position`,
    [tenantId, row.id, document.version]);
    const identical = storedChunks.rows.length === chunks.length && storedChunks.rows.every((stored, index) =>
      stored.position === chunks[index].position && stored.content === chunks[index].content && stored.content_sha256 === chunks[index].contentSha256);
    if (!identical) throw new DocumentIngestionError('catalog_conflict');
    return { inserted: false, chunks: 0 };
  }

  const inserted = await client.query<{ id: string }>(`INSERT INTO aegis.documents
    (tenant_id,source_identity,version,source_owner,ingestion_source,ingestion_revision,content_sha256,metadata)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb) RETURNING id`,
  [tenantId, document.sourceIdentity, document.version, syntheticSourceOwner, syntheticIngestionSource,
    document.sourceRevision, document.contentSha256, JSON.stringify(document.metadata)]);
  const documentId = inserted.rows[0]?.id;
  if (!documentId) throw new DocumentIngestionError('database_failure');
  for (const chunk of chunks) {
    await client.query(`INSERT INTO aegis.document_chunks
      (tenant_id,document_id,document_version,source_identity,position,content,content_sha256)
      VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [tenantId, documentId, document.version, document.sourceIdentity, chunk.position, chunk.content, chunk.contentSha256]);
  }
  return { inserted: true, chunks: chunks.length };
}

/** Only the restricted ingestion connection can write. It is never shared with HTTP runtime traffic. */
export async function ingestSyntheticCatalog(pool: Pool, catalog: readonly SyntheticDocument[] = syntheticDocuments): Promise<IngestionSummary> {
  validateSyntheticCatalog(catalog);
  const client = await pool.connect();
  try {
    const identity = await client.query<{ database: string; role: string; superuser: boolean; bypassRls: boolean;
      canLogin: boolean; createRole: boolean; createDb: boolean; inherit: boolean; member: boolean;
      replication: boolean;
      schemaCreate: boolean; publicCreate: boolean; migrationSchemaCreate: boolean; docUpdate: boolean; docDelete: boolean; docTruncate: boolean;
      chunkUpdate: boolean; chunkDelete: boolean; chunkTruncate: boolean; docSelect: boolean; docInsert: boolean;
      chunkSelect: boolean; chunkInsert: boolean; docOther: boolean; chunkOther: boolean;
      docColumnAcl: boolean; chunkColumnAcl: boolean; docPublicAcl: boolean; chunkPublicAcl: boolean;
      otherTablePrivileges: boolean }>(`SELECT current_database() database,
      current_user role,r.rolcanlogin AS "canLogin",r.rolsuper superuser,r.rolbypassrls AS "bypassRls",r.rolcreaterole AS "createRole",
      r.rolcreatedb AS "createDb",r.rolinherit AS inherit,r.rolreplication AS replication,
      EXISTS(SELECT 1 FROM pg_auth_members m WHERE m.member=r.oid OR m.roleid=r.oid) AS member,
      has_schema_privilege(current_user,'aegis','CREATE') AS "schemaCreate",
      has_schema_privilege(current_user,'public','CREATE') AS "publicCreate",
      has_schema_privilege(current_user,'aegis_migrations','CREATE') AS "migrationSchemaCreate",
      has_table_privilege(current_user,'aegis.documents','SELECT') AS "docSelect",
      has_table_privilege(current_user,'aegis.documents','INSERT') AS "docInsert",
      has_table_privilege(current_user,'aegis.documents','UPDATE') AS "docUpdate",
      has_table_privilege(current_user,'aegis.documents','DELETE') AS "docDelete",
      has_table_privilege(current_user,'aegis.documents','TRUNCATE') AS "docTruncate",
      has_table_privilege(current_user,'aegis.documents','REFERENCES,TRIGGER') AS "docOther",
      has_table_privilege(current_user,'aegis.document_chunks','SELECT') AS "chunkSelect",
      has_table_privilege(current_user,'aegis.document_chunks','INSERT') AS "chunkInsert",
      has_table_privilege(current_user,'aegis.document_chunks','UPDATE') AS "chunkUpdate",
      has_table_privilege(current_user,'aegis.document_chunks','DELETE') AS "chunkDelete",
      has_table_privilege(current_user,'aegis.document_chunks','TRUNCATE') AS "chunkTruncate"
      ,has_table_privilege(current_user,'aegis.document_chunks','REFERENCES,TRIGGER') AS "chunkOther"
      ,EXISTS(SELECT 1 FROM pg_attribute a WHERE a.attrelid='aegis.documents'::regclass AND a.attnum > 0 AND NOT a.attisdropped AND a.attacl IS NOT NULL) AS "docColumnAcl"
      ,EXISTS(SELECT 1 FROM pg_attribute a WHERE a.attrelid='aegis.document_chunks'::regclass AND a.attnum > 0 AND NOT a.attisdropped AND a.attacl IS NOT NULL) AS "chunkColumnAcl"
      ,EXISTS(SELECT 1 FROM pg_class c,LATERAL aclexplode(COALESCE(c.relacl,acldefault('r',c.relowner))) x
        WHERE c.oid='aegis.documents'::regclass AND x.grantee=0) AS "docPublicAcl"
      ,EXISTS(SELECT 1 FROM pg_class c,LATERAL aclexplode(COALESCE(c.relacl,acldefault('r',c.relowner))) x
        WHERE c.oid='aegis.document_chunks'::regclass AND x.grantee=0) AS "chunkPublicAcl"
      ,EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE c.relkind IN ('r','p','v','m') AND n.nspname NOT IN ('pg_catalog','information_schema')
          AND c.oid NOT IN ('aegis.documents'::regclass,'aegis.document_chunks'::regclass)
          AND has_table_privilege(current_user,c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')) AS "otherTablePrivileges"
      FROM pg_roles r WHERE r.rolname=current_user`);
    const row = identity.rows[0];
    if (row?.database !== 'aegis_test') throw new DocumentIngestionError('unsafe_target');
    if (row.role !== 'aegis_ingest' || !row.canLogin || row.superuser || row.bypassRls || row.createRole || row.createDb ||
        row.inherit || row.replication || row.member || row.schemaCreate || row.publicCreate || row.migrationSchemaCreate || !row.docSelect || !row.docInsert ||
        row.docUpdate || row.docDelete || row.docTruncate || !row.chunkSelect || !row.chunkInsert ||
        row.docOther || row.chunkUpdate || row.chunkDelete || row.chunkTruncate || row.chunkOther || row.docColumnAcl || row.chunkColumnAcl ||
        row.docPublicAcl || row.chunkPublicAcl || row.otherTablePrivileges) {
      throw new DocumentIngestionError('unsafe_role');
    }
    await client.query('BEGIN');
    await client.query("SELECT set_config('aegis.access_mode','catalog_ingestion',true),set_config('aegis.tenant_id','',true)");
    let documentsInserted = 0;
    let documentsUnchanged = 0;
    let chunksInserted = 0;
    for (const document of catalog) {
      const result = await ingestDocument(client, document);
      if (result.inserted) documentsInserted++; else documentsUnchanged++;
      chunksInserted += result.chunks;
    }
    await client.query('COMMIT');
    return { documentsInserted, documentsUnchanged, chunksInserted };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    if (error instanceof DocumentIngestionError) throw error;
    throw new DocumentIngestionError('database_failure');
  } finally { client.release(); }
}

export function validateIngestionConnection(connectionString: string): URL {
  let url: URL;
  try { url = new URL(connectionString); } catch { throw new DocumentIngestionError('unsafe_target'); }
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
      url.pathname !== '/aegis_test' || url.username !== 'aegis_ingest' || url.search || url.hash) {
    throw new DocumentIngestionError('unsafe_target');
  }
  return url;
}

export function validateIngestionArgs(args: readonly string[]): boolean {
  if (args.length === 0) return false;
  if (args.length === 1 && args[0] === '--apply') return true;
  throw new Error('Use no arguments for dry-run or exactly --apply for protected ingestion.');
}

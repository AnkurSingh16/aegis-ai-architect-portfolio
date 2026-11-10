import type { Pool, PoolClient } from 'pg';
import { chunkSyntheticDocument, syntheticDocumentTenantId, syntheticIngestionSource, syntheticDocuments,
  syntheticSourceOwner, validateSyntheticCatalog, type SyntheticDocument } from './catalog.js';

export class DocumentIngestionError extends Error {
  constructor(readonly code: 'unsafe_target' | 'unsafe_role' | 'catalog_conflict' | 'database_failure') {
    super('Synthetic document ingestion failed.');
  }
}

export interface IngestionSummary { documentsInserted: number; documentsUnchanged: number; chunksInserted: number }
export const approvedLocalPostgresSystemIdentifier = '7701292369980424230';

export interface DockerPostgresEvidence {
  containerIpAddresses: readonly string[];
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Validates explicit `docker --context desktop-linux inspect` output without exposing it. */
export function parseDesktopPostgresInspect(value: unknown): DockerPostgresEvidence {
  if (!Array.isArray(value) || value.length !== 1 || !record(value[0])) throw new DocumentIngestionError('unsafe_target');
  const container = value[0];
  const state = container.State;
  const settings = container.NetworkSettings;
  const portMap = record(settings) ? settings.Ports : undefined;
  const published = record(portMap) ? portMap['5432/tcp'] : undefined;
  const networks = record(settings) ? settings.Networks : undefined;
  if (container.Name !== '/aegis-ai-portfolio-git-postgres-1' || !record(state) || state.Running !== true ||
      !record(state.Health) || state.Health.Status !== 'healthy' || !Array.isArray(published) || published.length !== 1 ||
      !record(published[0]) || published[0].HostIp !== '127.0.0.1' || published[0].HostPort !== '5432' || !record(networks)) {
    throw new DocumentIngestionError('unsafe_target');
  }
  const addresses = Object.values(networks).flatMap((network) => record(network) && typeof network.IPAddress === 'string' && network.IPAddress.length > 0
    ? [network.IPAddress] : []);
  if (addresses.length === 0 || new Set(addresses).size !== addresses.length) throw new DocumentIngestionError('unsafe_target');
  return { containerIpAddresses: addresses };
}

export function validateLocalIngestionOptIn(env: NodeJS.ProcessEnv): void {
  if (env.AEGIS_LOCAL_DOCUMENT_INGEST_ENABLED !== 'true') throw new DocumentIngestionError('unsafe_target');
}

export function validateLocalIngestionConnection(connectionString: string): URL {
  let url: URL;
  try { url = new URL(connectionString); } catch { throw new DocumentIngestionError('unsafe_target'); }
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || url.hostname !== '127.0.0.1' || url.port !== '5432' ||
      url.pathname !== '/aegis_local' || url.username !== 'aegis_ingest' || url.search || url.hash) {
    throw new DocumentIngestionError('unsafe_target');
  }
  return url;
}

export function validateLocalAdminConnection(connectionString: string, ingestUrl: URL): URL {
  let url: URL;
  try { url = new URL(connectionString); } catch { throw new DocumentIngestionError('unsafe_target'); }
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || url.hostname !== '127.0.0.1' || url.port !== '5432' ||
      url.pathname !== '/aegis_local' || url.search || url.hash || !url.username ||
      url.username === 'aegis_ingest' || url.username === 'aegis_app' || url.username === ingestUrl.username) {
    throw new DocumentIngestionError('unsafe_target');
  }
  return url;
}

/** Read-only identity gate. Call again after TTY confirmation and before creating the writer pool. */
export async function verifyLocalIngestionTarget(adminPool: Pool, adminUrl: URL, ingestUrl: URL,
  dockerEvidence: DockerPostgresEvidence): Promise<string> {
  if (adminUrl.hostname !== '127.0.0.1' || adminUrl.port !== '5432' || adminUrl.pathname !== '/aegis_local' ||
      !adminUrl.username || adminUrl.username === 'aegis_ingest' || adminUrl.username === 'aegis_app' ||
      adminUrl.username === ingestUrl.username || ingestUrl.hostname !== '127.0.0.1' || ingestUrl.port !== '5432' ||
      ingestUrl.pathname !== '/aegis_local' || ingestUrl.username !== 'aegis_ingest') {
    throw new DocumentIngestionError('unsafe_target');
  }
  const client = await adminPool.connect();
  try {
    await client.query('BEGIN READ ONLY');
    const result = await client.query<{ database: string; role: string; serverAddress: string | null; serverPort: number;
      systemIdentifier: string }>(`SELECT current_database() AS database,current_user AS role,inet_server_addr()::text AS "serverAddress",
      inet_server_port() AS "serverPort",(SELECT system_identifier::text FROM pg_control_system()) AS "systemIdentifier"`);
    const identity = result.rows[0];
    if (!identity || identity.database !== 'aegis_local' || identity.role !== adminUrl.username || identity.role === ingestUrl.username ||
        identity.systemIdentifier !== approvedLocalPostgresSystemIdentifier || identity.serverPort !== 5432 ||
        identity.serverAddress === null || !dockerEvidence.containerIpAddresses.includes(identity.serverAddress)) {
      throw new DocumentIngestionError('unsafe_target');
    }
    await client.query('ROLLBACK');
    return identity.serverAddress;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    if (error instanceof DocumentIngestionError) throw error;
    throw new DocumentIngestionError('unsafe_target');
  } finally { client.release(); }
}

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
async function ingestCatalog(pool: Pool, expectedDatabase: 'aegis_test' | 'aegis_local',
  catalog: readonly SyntheticDocument[], expectedLocalServerAddress?: string): Promise<IngestionSummary> {
  validateSyntheticCatalog(catalog);
  const client = await pool.connect();
  try {
    const identity = await client.query<{ database: string; role: string; superuser: boolean; bypassRls: boolean;
      canLogin: boolean; createRole: boolean; createDb: boolean; inherit: boolean; member: boolean;
      serverAddress: string | null; serverPort: number;
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
      ,inet_server_addr()::text AS "serverAddress",inet_server_port() AS "serverPort"
      FROM pg_roles r WHERE r.rolname=current_user`);
    const row = identity.rows[0];
    if (row?.database !== expectedDatabase) throw new DocumentIngestionError('unsafe_target');
    if (expectedDatabase === 'aegis_local' && (!expectedLocalServerAddress || row.serverAddress !== expectedLocalServerAddress || row.serverPort !== 5432)) {
      throw new DocumentIngestionError('unsafe_target');
    }
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

/** Existing --apply target: deliberately remains restricted to aegis_test. */
export function ingestSyntheticCatalog(pool: Pool, catalog: readonly SyntheticDocument[] = syntheticDocuments): Promise<IngestionSummary> {
  return ingestCatalog(pool, 'aegis_test', catalog);
}

/** Separate local-only writer used exclusively by the additionally gated --apply-local path. */
export function ingestSyntheticCatalogLocal(pool: Pool, expectedLocalServerAddress: string,
  catalog: readonly SyntheticDocument[] = syntheticDocuments): Promise<IngestionSummary> {
  return ingestCatalog(pool, 'aegis_local', catalog, expectedLocalServerAddress);
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

export function validateIngestionArgs(args: readonly string[]): boolean | 'local' {
  if (args.length === 0) return false;
  if (args.length === 1 && args[0] === '--apply') return true;
  if (args.length === 1 && args[0] === '--apply-local') return 'local';
  throw new Error('Use no arguments for dry-run, --apply for isolated tests, or --apply-local for separately gated local ingestion.');
}

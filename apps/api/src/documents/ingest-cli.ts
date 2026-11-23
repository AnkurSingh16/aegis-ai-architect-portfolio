import { execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { Pool } from 'pg';
import { chunkSyntheticDocument, syntheticDocuments, validateSyntheticCatalog } from './catalog.js';
import { DocumentIngestionError, ingestSyntheticCatalog, ingestSyntheticCatalogLocal, validateIngestionArgs,
  validateIngestionConnection, validateLocalIngestionOptIn } from './ingestion.js';
import { LOCAL_COMPOSE_PROJECT, LocalIdentityError, confirmationPhrase, pinnedIdentityFromEnv, parseComposePs, selectPostgresContainer,
  validateLocalIngestionUrl, verifyClusterIdentity, verifyInspectedPostgres, type PinnedLocalIdentity } from './local-identity.js';

const testConfirmation = 'INGEST SYNTHETIC CATALOG INTO aegis_test';
const catalogRevision = 'aegis-support-docs-v1';

function docker(context: string | null, args: string[]): string {
  // Fixed binary and argument vector; no shell. Inspect templates select only identity, state, labels and port fields.
  const prefix = context === null ? [] : ['--context', context];
  return execFileSync('docker', [...prefix, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 20_000 });
}

/**
 * Resolves the PostgreSQL container through the exact Compose project and service, then checks the live container against the pinned
 * identity. Runs before any confirmation and again after it.
 */
function resolveLocalContainer(pinned: PinnedLocalIdentity): string {
  const activeContext = docker(null, ['context', 'show']).trim();
  if (activeContext !== pinned.dockerContext) throw new LocalIdentityError('docker_context_mismatch');
  const containerId = selectPostgresContainer(parseComposePs(docker(pinned.dockerContext,
    ['compose', '-p', LOCAL_COMPOSE_PROJECT, 'ps', '--format', 'json'])));
  // The pinned identity is the trust anchor: the Compose-resolved container must be the one recorded in local configuration.
  if (!containerId.toLowerCase().startsWith(pinned.containerId)) throw new LocalIdentityError('container_identity_mismatch');
  const template = '{"Id":{{json .Id}},"Config":{"Image":{{json .Config.Image}},"Labels":{{json .Config.Labels}}},' +
    '"State":{{json .State}},"NetworkSettings":{"Ports":{{json .NetworkSettings.Ports}}}}';
  const inspected = JSON.parse(docker(pinned.dockerContext, ['inspect', '--format', template, containerId])) as unknown;
  verifyInspectedPostgres(inspected, pinned);
  return containerId;
}

async function verifyLocalTarget(): Promise<{ pinned: PinnedLocalIdentity; connectionString: string; containerId: string }> {
  validateLocalIngestionOptIn(process.env);
  if (process.env.DATABASE_ADMIN_URL) throw new LocalIdentityError('admin_connection_not_allowed');
  const pinned = pinnedIdentityFromEnv(process.env);
  const connectionString = process.env.DOCUMENT_INGEST_LOCAL_DATABASE_URL ?? '';
  validateLocalIngestionUrl(connectionString, pinned.port);
  const containerId = resolveLocalContainer(pinned);
  const probe = new Pool({ connectionString, max: 1, connectionTimeoutMillis: 5000, statement_timeout: 5000,
    application_name: 'aegis-local-document-ingestion-preflight' });
  try {
    const client = await probe.connect();
    try { await verifyClusterIdentity(client, pinned); } finally { client.release(); }
  } finally { await probe.end(); }
  return { pinned, connectionString, containerId };
}

function errorCode(error: unknown): string {
  if (error instanceof LocalIdentityError || error instanceof DocumentIngestionError) return error.code;
  return 'ingestion_failed';
}

try {
  const mode = validateIngestionArgs(process.argv.slice(2));
  validateSyntheticCatalog();
  const chunks = syntheticDocuments.reduce((sum, document) => sum + chunkSyntheticDocument(document.content).length, 0);
  if (mode === false) {
    console.info(JSON.stringify({ event: 'documents.ingestion_dry_run', catalogDocuments: syntheticDocuments.length,
      catalogRevision, estimatedChunks: chunks, databaseAccess: false }));
  } else if (mode === true) {
    if (!stdin.isTTY || !stdout.isTTY) throw new Error('Interactive terminal required.');
    const connectionString = process.env.DOCUMENT_INGEST_DATABASE_URL;
    if (!connectionString) throw new Error('Restricted ingestion connection is required.');
    validateIngestionConnection(connectionString);
    const reader = createInterface({ input: stdin, output: stdout });
    try {
      if (await reader.question(`Type ${testConfirmation}: `) !== testConfirmation) throw new Error('Confirmation did not match.');
    } finally { reader.close(); }
    const pool = new Pool({ connectionString, max: 1, connectionTimeoutMillis: 5000, statement_timeout: 5000,
      application_name: 'aegis-synthetic-document-ingestion' });
    try {
      const summary = await ingestSyntheticCatalog(pool);
      console.info(JSON.stringify({ event: 'documents.ingestion_completed', ...summary }));
    } finally { await pool.end(); }
  } else {
    if (!stdin.isTTY || !stdout.isTTY) throw new Error('Interactive terminal required for local ingestion.');
    const first = await verifyLocalTarget();
    const phrase = confirmationPhrase(first.pinned, catalogRevision);
    const reader = createInterface({ input: stdin, output: stdout });
    try {
      if (await reader.question(`Type ${phrase}: `) !== phrase) throw new Error('Confirmation did not match.');
    } finally { reader.close(); }
    // Repeat the complete preflight after typed authorization so the target cannot change between approval and write.
    const { pinned, connectionString, containerId } = await verifyLocalTarget();
    const pool = new Pool({ connectionString, max: 1, connectionTimeoutMillis: 5000, statement_timeout: 5000,
      application_name: 'aegis-local-synthetic-document-ingestion' });
    try {
      const summary = await ingestSyntheticCatalogLocal(pool, pinned.systemIdentifier);
      console.info(JSON.stringify({ event: 'documents.local_ingestion_completed', dockerContext: pinned.dockerContext,
        composeProject: LOCAL_COMPOSE_PROJECT, containerIdPrefix: containerId.slice(0, 12), database: 'aegis_local',
        catalogRevision, ...summary }));
    } finally { await pool.end(); }
  }
} catch (error) {
  console.error(JSON.stringify({ event: 'documents.ingestion_failed', code: errorCode(error),
    message: 'Synthetic document ingestion was not completed.' }));
  process.exitCode = 1;
}

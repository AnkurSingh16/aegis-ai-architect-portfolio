import { execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { Pool } from 'pg';
import { chunkSyntheticDocument, syntheticDocuments, validateSyntheticCatalog } from './catalog.js';
import { ingestSyntheticCatalog, ingestSyntheticCatalogLocal, parseDesktopPostgresInspect, validateIngestionArgs,
  validateIngestionConnection, validateLocalAdminConnection, validateLocalIngestionConnection, validateLocalIngestionOptIn,
  verifyLocalIngestionTarget } from './ingestion.js';

const testConfirmation = 'INGEST SYNTHETIC CATALOG INTO aegis_test';
const localConfirmation = 'INGEST SYNTHETIC CATALOG INTO aegis_local';
const desktopContainer = 'aegis-ai-portfolio-git-postgres-1';

function inspectDesktopPostgres() {
  // Ask Docker for only the health, publish mapping, and network IP fields; avoid reading container environment data.
  const template = '{{.Name}}\n{{json .State}}\n{{json .NetworkSettings.Ports}}\n{{range .NetworkSettings.Networks}}{{.IPAddress}}\n{{end}}';
  const output = execFileSync('docker', ['--context', 'desktop-linux', 'inspect', '--format', template, desktopContainer],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  const [name, stateJson, portsJson, ...addressLines] = output.trimEnd().split('\n');
  const state = JSON.parse(stateJson ?? 'null') as unknown;
  const ports = JSON.parse(portsJson ?? 'null') as unknown;
  const addresses = addressLines.filter((address) => /^\d{1,3}(?:\.\d{1,3}){3}$/.test(address));
  const networks = Object.fromEntries(addresses.map((address, index) => [`network${index}`, { IPAddress: address }]));
  return parseDesktopPostgresInspect([{ Name: name, State: state,
    NetworkSettings: { Ports: ports, Networks: networks } }]);
}

async function verifyLocalTarget(): Promise<{ ingestConnection: string; serverAddress: string }> {
  validateLocalIngestionOptIn(process.env);
  const ingestConnection = process.env.DOCUMENT_INGEST_LOCAL_DATABASE_URL;
  const adminConnection = process.env.DATABASE_ADMIN_URL;
  if (!ingestConnection || !adminConnection) throw new Error('Local database preflight configuration is missing.');
  const ingestUrl = validateLocalIngestionConnection(ingestConnection);
  const adminUrl = validateLocalAdminConnection(adminConnection, ingestUrl);
  const dockerEvidence = inspectDesktopPostgres();
  const adminPool = new Pool({ connectionString: adminConnection, max: 1, connectionTimeoutMillis: 5000,
    application_name: 'aegis-local-document-ingestion-preflight' });
  let serverAddress: string;
  try { serverAddress = await verifyLocalIngestionTarget(adminPool, adminUrl, ingestUrl, dockerEvidence); }
  finally { await adminPool.end(); }
  return { ingestConnection, serverAddress };
}

try {
  const mode = validateIngestionArgs(process.argv.slice(2));
  validateSyntheticCatalog();
  const chunks = syntheticDocuments.reduce((sum, document) => sum + chunkSyntheticDocument(document.content).length, 0);
  if (mode === false) {
    console.info(JSON.stringify({ event: 'documents.ingestion_dry_run', catalogDocuments: syntheticDocuments.length,
      catalogRevision: 'aegis-support-docs-v1', estimatedChunks: chunks, databaseAccess: false }));
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
    await verifyLocalTarget();
    const reader = createInterface({ input: stdin, output: stdout });
    try {
      if (await reader.question(`Type ${localConfirmation}: `) !== localConfirmation) throw new Error('Confirmation did not match.');
    } finally { reader.close(); }
    // Recheck the cluster identity and explicit Docker Desktop mapping after typed authorization.
    const { ingestConnection: connectionString, serverAddress } = await verifyLocalTarget();
    const pool = new Pool({ connectionString, max: 1, connectionTimeoutMillis: 5000, statement_timeout: 5000,
      application_name: 'aegis-local-synthetic-document-ingestion' });
    try {
      const summary = await ingestSyntheticCatalogLocal(pool, serverAddress);
      console.info(JSON.stringify({ event: 'documents.local_ingestion_completed', ...summary }));
    } finally { await pool.end(); }
  }
} catch {
  console.error(JSON.stringify({ event: 'documents.ingestion_failed', message: 'Synthetic document ingestion was not completed.' }));
  process.exitCode = 1;
}

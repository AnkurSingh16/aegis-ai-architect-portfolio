import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { Pool } from 'pg';
import { chunkSyntheticDocument, syntheticDocuments, validateSyntheticCatalog } from './catalog.js';
import { ingestSyntheticCatalog, validateIngestionArgs, validateIngestionConnection } from './ingestion.js';

const confirmation = 'INGEST SYNTHETIC CATALOG INTO aegis_test';

try {
  const apply = validateIngestionArgs(process.argv.slice(2));
  validateSyntheticCatalog();
  const chunks = syntheticDocuments.reduce((sum, document) => sum + chunkSyntheticDocument(document.content).length, 0);
  if (!apply) {
    console.info(JSON.stringify({ event: 'documents.ingestion_dry_run', catalogDocuments: syntheticDocuments.length,
      catalogRevision: 'aegis-support-docs-v1', estimatedChunks: chunks, databaseAccess: false }));
  } else {
    if (!stdin.isTTY || !stdout.isTTY) throw new Error('Interactive terminal required.');
    const connectionString = process.env.DOCUMENT_INGEST_DATABASE_URL;
    if (!connectionString) throw new Error('Restricted ingestion connection is required.');
    validateIngestionConnection(connectionString);
    const reader = createInterface({ input: stdin, output: stdout });
    try {
      if (await reader.question(`Type ${confirmation}: `) !== confirmation) throw new Error('Confirmation did not match.');
    } finally { reader.close(); }
    const pool = new Pool({ connectionString, max: 1, connectionTimeoutMillis: 5000, statement_timeout: 5000,
      application_name: 'aegis-synthetic-document-ingestion' });
    try {
      const summary = await ingestSyntheticCatalog(pool);
      console.info(JSON.stringify({ event: 'documents.ingestion_completed', ...summary }));
    } finally { await pool.end(); }
  }
} catch {
  console.error(JSON.stringify({ event: 'documents.ingestion_failed', message: 'Synthetic document ingestion was not completed.' }));
  process.exitCode = 1;
}

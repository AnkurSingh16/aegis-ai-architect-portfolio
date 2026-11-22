import { Pool } from 'pg';
import { ingestSyntheticCatalog } from './ingestion.js';

/**
 * Seeds the source-controlled synthetic corpus into the local stack through the ingestion role, using the same catalog function the
 * ingestion tests use. Runs only when given the ingestion connection explicitly (DATABASE_INGEST_URL). The corpus is invented text.
 *
 *   docker compose run --rm -e DATABASE_INGEST_URL=... migrate node apps/api/dist/documents/seed-local-corpus.js
 */
const url = process.env.DATABASE_INGEST_URL;
if (!url) throw new Error('DATABASE_INGEST_URL is required');
const pool = new Pool({ connectionString: url, max: 2 });
ingestSyntheticCatalog(pool)
  .then((summary) => process.stdout.write(`${JSON.stringify({ event: 'synthetic_corpus.seeded', ...summary })}\n`))
  .catch(() => { process.stderr.write(`${JSON.stringify({ event: 'synthetic_corpus.failed' })}\n`); process.exitCode = 1; })
  .finally(() => pool.end());

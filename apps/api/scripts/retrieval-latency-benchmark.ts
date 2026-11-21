/**
 * OPT-IN retrieval latency benchmark (C2). It is NOT part of CI. It needs AEGIS_RUN_RETRIEVAL_BENCHMARK=1 and a disposable local
 * PostgreSQL database (the name must end in _bench or aegis_test, and the host must be loopback). It uses deterministic synthetic
 * corpora and synthetic query vectors. No embedding model is called. Results are written to the output file and a summary is
 * printed. Usage (from apps/api):
 *   AEGIS_RUN_RETRIEVAL_BENCHMARK=1 TEST_DATABASE_ADMIN_URL=... TEST_DATABASE_URL=... DATABASE_APP_PASSWORD=... \
 *     npx tsx scripts/retrieval-latency-benchmark.ts <output.json>
 */
import { writeFileSync } from 'node:fs';
import os from 'node:os';
import { performance } from 'node:perf_hooks';
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { Pool } from 'pg';
import { createDatabasePool } from '../src/storage/database.js';
import { migrateDatabase } from '../src/storage/migrations.js';
import { withAuthenticatedTransaction } from '../src/auth/transaction.js';
import type { VerifiedPrincipal } from '../src/auth/token.js';
import type { TenantQueryable } from '../src/security/tool-approval-store.js';
import { retrieveDocumentChunks, retrievalLimits } from '../src/documents/retrieval.js';
import { retrieveByVector, type VectorHit } from '../src/retrieval/vector-retrieval.js';
import { weightedReciprocalRankFusion } from '../src/retrieval/ranking-metrics.js';
import { summarize } from '../src/retrieval/bench/stats.js';
import { clusterQuery, EMBEDDING_DIM, generateCorpus, mulberry32, type SyntheticDocument } from '../src/retrieval/bench/synthetic-corpus.js';

const GUARD = process.env.AEGIS_RUN_RETRIEVAL_BENCHMARK === '1';
const outputPath = process.argv[2];
if (!GUARD) throw new Error('Refusing to run: set AEGIS_RUN_RETRIEVAL_BENCHMARK=1 (opt-in, not part of CI).');
if (!outputPath) throw new Error('usage: retrieval-latency-benchmark.ts <output.json>');
const adminUrl = process.env.TEST_DATABASE_ADMIN_URL;
const runtimeUrl = process.env.TEST_DATABASE_URL;
if (!adminUrl || !runtimeUrl) throw new Error('Set TEST_DATABASE_ADMIN_URL and TEST_DATABASE_URL.');
for (const url of [adminUrl, runtimeUrl]) {
  const parsed = new URL(url);
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname)) throw new Error('Refusing: benchmark database must be on loopback.');
  if (!/(_bench|aegis_test)$/.test(parsed.pathname)) throw new Error('Refusing: database name must end in _bench or aegis_test (disposable).');
}

const SIZES = [4, 500, 1000, 5000] as const;
const WARM_UP = 30;
const MEASURED = 200;
const issuer = 'https://retrieval-bench.integration.example/';
const subject = `bench-${randomUUID()}|reader`;
const principal: VerifiedPrincipal = { issuer, subject, scopes: new Set(['read:cases']) };
const admin = new Pool({ connectionString: adminUrl, max: 2 });
const runtime = createDatabasePool(runtimeUrl, 2);
const tenantA = randomUUID();
const tenantB = randomUUID();

const withTenant = <T>(tenantId: string, op: (client: PoolClient) => Promise<T>) =>
  withAuthenticatedTransaction(runtime, principal, tenantId, 'read:cases', (client) => op(client as unknown as PoolClient));
const runtimeTenant = <T>(tenantId: string, op: (client: TenantQueryable) => Promise<T>) =>
  withAuthenticatedTransaction(runtime, principal, tenantId, 'read:cases', (client) => op(client as unknown as TenantQueryable));

const vecLiteral = (v: readonly number[]) => `[${v.join(',')}]`;

/** Inserts one corpus through the admin role in batches. Returns the chunk id of every document, in corpus order. */
async function load(documents: readonly SyntheticDocument[]): Promise<Map<number, { chunkId: string; tenant: string }>> {
  const tenantIds = { a: tenantA, b: tenantB };
  const out = new Map<number, { chunkId: string; tenant: string }>();
  for (let start = 0; start < documents.length; start += 100) {
    const batch = documents.slice(start, start + 100);
    const docValues: unknown[] = [];
    const docSql = batch.map((d, i) => {
      const o = i * 7;
      docValues.push(tenantIds[d.tenant], d.sourceIdentity, 1, 'bench-owner', 'source-controlled-synthetic-catalog', 'bench-revision-1', d.contentSha256);
      return `($${o + 1}::uuid,$${o + 2}::text,$${o + 3}::integer,$${o + 4}::text,$${o + 5}::text,$${o + 6}::text,$${o + 7}::text,'{}'::jsonb)`;
    }).join(',');
    const docRows = await admin.query<{ id: string; source_identity: string; tenant_id: string }>(
      `INSERT INTO aegis.documents (tenant_id,source_identity,version,source_owner,ingestion_source,ingestion_revision,content_sha256,metadata)
       VALUES ${docSql} RETURNING id, source_identity, tenant_id`, docValues);
    const docIdBySource = new Map(docRows.rows.map((r) => [r.source_identity, r.id]));
    const chunkValues: unknown[] = [];
    const chunkSql = batch.map((d, i) => {
      const o = i * 7;
      chunkValues.push(tenantIds[d.tenant], docIdBySource.get(d.sourceIdentity), 1, d.sourceIdentity, 0, d.content, d.contentSha256);
      return `($${o + 1}::uuid,$${o + 2}::uuid,$${o + 3}::integer,$${o + 4}::text,$${o + 5}::integer,$${o + 6}::text,$${o + 7}::text)`;
    }).join(',');
    const chunkRows = await admin.query<{ id: string; source_identity: string }>(
      `INSERT INTO aegis.document_chunks (tenant_id,document_id,document_version,source_identity,position,content,content_sha256)
       VALUES ${chunkSql} RETURNING id, source_identity`, chunkValues);
    const chunkBySource = new Map(chunkRows.rows.map((r) => [r.source_identity, r.id]));
    const embedValues: unknown[] = [];
    const embedSql = batch.map((d, i) => {
      const o = i * 5;
      embedValues.push(chunkBySource.get(d.sourceIdentity), tenantIds[d.tenant], 'nomic-embed-text',
        '0a109f422b47e3a30ba2b10eca18548e944e8a23073ee3f3e947efcf3c45e59f', vecLiteral(d.vector));
      return `($${o + 1}::uuid,$${o + 2}::uuid,$${o + 3}::text,$${o + 4}::text,$${o + 5}::vector)`;
    }).join(',');
    await admin.query(`INSERT INTO aegis.chunk_embeddings (chunk_id,tenant_id,model,model_digest,embedding) VALUES ${embedSql}`, embedValues);
    batch.forEach((d) => out.set(d.index, { chunkId: chunkBySource.get(d.sourceIdentity)!, tenant: d.tenant }));
  }
  return out;
}

async function clear(): Promise<void> {
  await admin.query('DELETE FROM aegis.chunk_embeddings WHERE tenant_id = ANY($1::uuid[])', [[tenantA, tenantB]]);
  await admin.query('DELETE FROM aegis.document_chunks WHERE tenant_id = ANY($1::uuid[])', [[tenantA, tenantB]]);
  await admin.query('DELETE FROM aegis.documents WHERE tenant_id = ANY($1::uuid[])', [[tenantA, tenantB]]);
  await admin.query('VACUUM ANALYZE aegis.chunk_embeddings');
  await admin.query('VACUUM ANALYZE aegis.document_chunks');
}

const cosine = (a: readonly number[], b: readonly number[]) => {
  let dot = 0; let na = 0; let nb = 0;
  for (let i = 0; i < a.length; i += 1) { dot += a[i]! * b[i]!; na += a[i]! * a[i]!; nb += b[i]! * b[i]!; }
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
};

interface Sample { totalMs: number; functionMs: number; fusionMs?: number }
interface Cell { path: 'lexical' | 'vector' | 'hybrid'; queryType: string; size: number; warmUp: number; measured: number;
  total: ReturnType<typeof summarize>; function: ReturnType<typeof summarize>; fusion: ReturnType<typeof summarize> | null; transactionOverheadP50Ms: number | null; resultCountMin: number; resultCountMax: number }

async function measure(size: number, path: Cell['path'], queryType: string, run: (i: number) => Promise<{ functionMs: number; fusionMs?: number; count: number }>): Promise<Cell> {
  for (let i = 0; i < WARM_UP; i += 1) await run(i);
  const samples: Sample[] = []; const counts: number[] = [];
  for (let i = 0; i < MEASURED; i += 1) {
    const t0 = performance.now();
    const r = await run(i);
    const total = performance.now() - t0;
    samples.push({ totalMs: total, functionMs: r.functionMs, ...(r.fusionMs !== undefined ? { fusionMs: r.fusionMs } : {}) });
    counts.push(r.count);
  }
  const overhead = samples.map((s) => s.totalMs - s.functionMs);
  return { path, queryType, size, warmUp: WARM_UP, measured: MEASURED,
    total: summarize(samples.map((s) => s.totalMs)), function: summarize(samples.map((s) => s.functionMs)),
    fusion: samples[0]?.fusionMs !== undefined ? summarize(samples.map((s) => s.fusionMs!)) : null,
    transactionOverheadP50Ms: summarize(overhead).p50, resultCountMin: Math.min(...counts), resultCountMax: Math.max(...counts) };
}

async function explain(sql: string, params: unknown[], tenantId: string): Promise<unknown> {
  return withTenant(tenantId, async (client) => {
    await client.query("SET LOCAL enable_seqscan = on");
    const r = await client.query<{ 'QUERY PLAN': unknown }>(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${sql}`, params);
    return r.rows[0]!['QUERY PLAN'];
  });
}
const nodeTypes = (plan: unknown): string[] => {
  const out: string[] = [];
  const walk = (n: Record<string, unknown>) => { if (typeof n['Node Type'] === 'string') out.push(String(n['Node Type']) + (n['Index Name'] ? ` (${n['Index Name']})` : '')); for (const c of (n.Plans as Record<string, unknown>[] | undefined) ?? []) walk(c); };
  const root = (plan as { Plan: Record<string, unknown> }[])[0]!.Plan;
  walk(root);
  return out;
};

const VECTOR_SQL = `SELECT d.source_identity, c.id AS chunk_id, c.content, 1 - (e.embedding <=> $2::vector) AS similarity
       FROM aegis.chunk_embeddings e
       JOIN aegis.document_chunks c ON c.id = e.chunk_id AND c.tenant_id = e.tenant_id
       JOIN aegis.documents d ON d.tenant_id = c.tenant_id AND d.id = c.document_id
         AND d.version = c.document_version AND d.source_identity = c.source_identity
      WHERE e.tenant_id = $1 AND e.model = $3
      ORDER BY e.embedding <=> $2::vector, c.id LIMIT $4`;
const LEXICAL_SQL = `WITH parsed AS (SELECT plainto_tsquery('english'::regconfig,$1) AS query), ranked AS (
      SELECT c.id AS chunk_id,d.source_identity,d.version AS document_version,c.position,
        d.metadata->>'title' AS title,c.content,ts_rank_cd(c.search_vector,p.query) AS rank
      FROM aegis.document_chunks c JOIN aegis.documents d
        ON d.tenant_id=c.tenant_id AND d.id=c.document_id AND d.version=c.document_version AND d.source_identity=c.source_identity
      CROSS JOIN parsed p WHERE c.tenant_id=$2 AND c.search_vector @@ p.query
    ) SELECT chunk_id FROM ranked WHERE rank >= $3 ORDER BY rank DESC,source_identity ASC,document_version DESC,position ASC,chunk_id ASC LIMIT $4`;

async function main(): Promise<void> {
  await migrateDatabase(adminUrl!, process.env.DATABASE_APP_PASSWORD ?? '', process.env.DATABASE_INGEST_PASSWORD ?? '');
  await admin.query('INSERT INTO aegis.tenants (id, name) VALUES ($1, $2), ($3, $4)', [tenantA, 'Synthetic North', tenantB, 'Synthetic South']);
  await admin.query('INSERT INTO aegis.memberships (issuer,subject,tenant_id,role) VALUES ($1,$2,$3,$4), ($1,$2,$5,$4)', [issuer, subject, tenantA, 'reader', tenantB]);
  const dbConfig = (await admin.query<{ name: string; setting: string }>(`SELECT name, setting FROM pg_settings WHERE name IN
    ('server_version','shared_buffers','work_mem','maintenance_work_mem','effective_cache_size','max_parallel_workers_per_gather','hnsw.ef_search','max_connections')`)).rows;
  const ext = (await admin.query<{ extversion: string }>("SELECT extversion FROM pg_extension WHERE extname = 'vector'")).rows[0]!.extversion;
  const results: { size: number; loadMs: number; tenantADocs: number; sizes: Record<string, string | number | null>; cells: Cell[]; plans: Record<string, unknown>; correctness: Record<string, unknown> }[] = [];
  const corpusFor = (size: number) => generateCorpus({ documents: size, clusters: Math.max(4, Math.round(size / 100)), seed: 20261121, secondTenantShare: 0.1 });

  for (const size of SIZES) {
    await clear();
    const corpus = corpusFor(size);
    const t0 = performance.now();
    const ids = await load(corpus.documents);
    const loadMs = performance.now() - t0;
    await admin.query('ANALYZE aegis.document_chunks'); await admin.query('ANALYZE aegis.chunk_embeddings');
    const sizes = (await admin.query<{ c: string; hnsw: string; gin: string; emb: string }>(`SELECT
      (SELECT count(*)::text FROM aegis.document_chunks WHERE tenant_id = ANY($1::uuid[])) AS c,
      pg_size_pretty(pg_relation_size('aegis.chunk_embeddings_cosine')) AS hnsw,
      pg_size_pretty(pg_relation_size('aegis.document_chunks_search_vector_gin')) AS gin,
      pg_size_pretty(pg_total_relation_size('aegis.chunk_embeddings')) AS emb`, [[tenantA, tenantB]])).rows[0]!;
    const sizeInfo: Record<string, string | number | null> = { chunks: Number(sizes.c), hnswIndex: sizes.hnsw, ginIndex: sizes.gin, embeddingTable: sizes.emb };
    const docsA = corpus.documents.filter((d) => d.tenant === 'a');
    const tenantAIds = new Set(docsA.map((d) => ids.get(d.index)!.chunkId));
    const tenantBIds = new Set(corpus.documents.filter((d) => d.tenant === 'b').map((d) => ids.get(d.index)!.chunkId));

    // Query sets. Distinct queries per type, cycled through the measured runs.
    const commonWords = corpus.vocab.slice(0, 5);
    const rareWords = corpus.vocab.slice(500, 520);
    const lexQueries = {
      common: Array.from({ length: 20 }, (_, i) => commonWords[i % commonWords.length]!),
      rare: Array.from({ length: 20 }, (_, i) => rareWords[i % rareWords.length]!),
      multi: Array.from({ length: 20 }, (_, i) => corpus.vocab.slice((i % corpus.centres.length) * 20, (i % corpus.centres.length) * 20 + 3).join(' ')),
      none: Array.from({ length: 20 }, () => 'zzqxwv'),
    } as const;
    const vecQueries = {
      cluster: Array.from({ length: 20 }, (_, i) => clusterQuery(corpus, i % corpus.centres.length, 1000 + i).vector),
      noisy: Array.from({ length: 20 }, (_, i) => corpus.documents[(i * 37) % corpus.documents.length]!.vector.map((x, j) => x + ((j * 7919 + i) % 13 - 6) * 0.001)),
      remote: Array.from({ length: 20 }, (_, i) => { const r = mulberry32(5000 + i); return Array.from({ length: EMBEDDING_DIM }, () => r() - 0.5); }),
    } as const;
    const pairQueries = Array.from({ length: 20 }, (_, i) => clusterQuery(corpus, i % corpus.centres.length, 2000 + i));

    const cells: Cell[] = [];
    // Exact comparison: the same vector query with the index disabled for this transaction only (a sequential, exact scan).
    cells.push(await measure(size, 'vector', 'cluster_exact', async (i) => {
      const vector = vecQueries.cluster[i % vecQueries.cluster.length]!;
      let count = 0; let functionMs = 0;
      await runtimeTenant(tenantA, async (client) => {
        await client.query('SET LOCAL enable_indexscan = off');
        const f0 = performance.now();
        const hits: VectorHit[] = await retrieveByVector(client, tenantA, vector, 5);
        functionMs = performance.now() - f0;
        count = hits.length;
      });
      return { functionMs, count };
    }));
    for (const [type, list] of Object.entries(lexQueries)) {
      cells.push(await measure(size, 'lexical', type, async (i) => {
        const text = list[i % list.length]!;
        let count = 0; let functionMs = 0;
        const t = performance.now();
        await withTenant(tenantA, async (client) => {
          const f0 = performance.now();
          const rows = await retrieveDocumentChunks(client, tenantA, text);
          functionMs = performance.now() - f0;
          count = rows.length;
          for (const row of rows) if (!tenantAIds.has(row.chunkId)) throw new Error('TENANT ISOLATION VIOLATION (lexical)');
        });
        void t;
        return { functionMs, count };
      }));
    }
    for (const [type, list] of Object.entries(vecQueries)) {
      cells.push(await measure(size, 'vector', type, async (i) => {
        const vector = list[i % list.length]!;
        let count = 0; let functionMs = 0;
        await runtimeTenant(tenantA, async (client) => {
          const f0 = performance.now();
          const hits: VectorHit[] = await retrieveByVector(client, tenantA, vector, 5);
          functionMs = performance.now() - f0;
          count = hits.length;
          for (const h of hits) if (!tenantAIds.has(h.chunkId)) throw new Error('TENANT ISOLATION VIOLATION (vector)');
        });
        return { functionMs, count };
      }));
    }
    cells.push(await measure(size, 'hybrid', 'cluster_pair', async (i) => {
      const q = pairQueries[i % pairQueries.length]!;
      let count = 0; let functionMs = 0; let fusionMs = 0;
      await withTenant(tenantA, async (client) => {
        const f0 = performance.now();
        const lex = await retrieveDocumentChunks(client, tenantA, q.text);
        const vec = await retrieveByVector(client as unknown as TenantQueryable, tenantA, q.vector, 5);
        functionMs = performance.now() - f0;
        const x0 = performance.now();
        const fused = weightedReciprocalRankFusion(lex.map((r) => r.chunkId), vec.map((h) => h.chunkId), 0.5);
        fusionMs = performance.now() - x0;
        count = fused.slice(0, 5).length;
      });
      return { functionMs, fusionMs, count };
    }));

    // Correctness at this size.
    const correctness: Record<string, unknown> = {};
    const vectorChecks = pairQueries.slice(0, 10).map((q) => {
      const expected = corpus.documents.filter((d) => d.tenant === 'a')
        .map((d) => ({ id: ids.get(d.index)!.chunkId, s: cosine(q.vector, d.vector) }))
        .sort((a, b) => b.s - a.s || (a.id < b.id ? -1 : 1)).slice(0, 5).map((e) => e.id);
        return expected;
    });
    let rankingMismatches = 0;
    for (let i = 0; i < vectorChecks.length; i += 1) {
      const hits = await runtimeTenant(tenantA, (client) => retrieveByVector(client, tenantA, pairQueries[i]!.vector, 5));
      if (JSON.stringify(hits.map((h) => h.chunkId)) !== JSON.stringify(vectorChecks[i])) rankingMismatches += 1;
    }
    correctness.vectorRankingMismatchesOf10 = rankingMismatches;
    // Approximate-index recall: the default plan (which may use HNSW) against the exact scan, over 40 queries.
    // Recall@5 = overlap of the two top-5 sets divided by 5. Every query is checked, and the mean is reported.
    let recallSum = 0; let exactMatches = 0; let defaultUsedIndex = 0;
    for (let i = 0; i < 40; i += 1) {
      const q = clusterQuery(corpus, i % corpus.centres.length, 3000 + i).vector;
      const approx = await runtimeTenant(tenantA, (client) => retrieveByVector(client, tenantA, q, 5));
      const exact = await runtimeTenant(tenantA, async (client) => { await client.query('SET LOCAL enable_indexscan = off');
        return retrieveByVector(client, tenantA, q, 5); });
      const exactIds = new Set(exact.map((h) => h.chunkId));
      const overlap = approx.filter((h) => exactIds.has(h.chunkId)).length;
      recallSum += overlap / 5;
      if (overlap === 5) exactMatches += 1;
      const plan = await explain(VECTOR_SQL, [tenantA, vecLiteral(q), 'nomic-embed-text', 5], tenantA);
      if (nodeTypes(plan).some((n) => n.includes('chunk_embeddings_cosine'))) defaultUsedIndex += 1;
    }
    correctness.recallAt5MeanOf40 = Math.round((recallSum / 40) * 1000) / 1000;
    correctness.queriesWithIdenticalTop5Of40 = exactMatches;
    correctness.queriesUsingHnswIndexOf40 = defaultUsedIndex;
    let isolationViolations = 0; let lexicalOrderViolations = 0; let budgetViolations = 0; let topKViolations = 0;
    for (const text of [...lexQueries.common, ...lexQueries.multi].slice(0, 10)) {
      const rows = await withTenant(tenantA, (client) => retrieveDocumentChunks(client, tenantA, text));
      if (rows.some((r) => !tenantAIds.has(r.chunkId))) isolationViolations += 1;
      for (let k = 1; k < rows.length; k += 1) if (rows[k]!.rank > rows[k - 1]!.rank) lexicalOrderViolations += 1;
      const bytes = rows.reduce((s, r) => s + Buffer.byteLength(r.content, 'utf8'), 0);
      if (bytes > retrievalLimits.maxContextBytes) budgetViolations += 1;
      if (rows.length > retrievalLimits.maxTopK) topKViolations += 1;
    }
    for (const v of vecQueries.cluster.slice(0, 10)) {
      const hits = await runtimeTenant(tenantA, (client) => retrieveByVector(client, tenantA, v, 5));
      if (hits.some((h) => !tenantAIds.has(h.chunkId))) isolationViolations += 1;
      if (hits.length !== Math.min(5, docsA.length)) topKViolations += 1;
    }
    const bIds = [...tenantBIds];
    const crossTenant = await runtimeTenant(tenantA, (client) => client.query<{ n: string }>(
      'SELECT count(*)::text AS n FROM aegis.chunk_embeddings WHERE chunk_id = ANY($1::uuid[])', [bIds.slice(0, 50)]));
    correctness.isolationViolations = isolationViolations;
    correctness.crossTenantEmbeddingsVisibleToTenantA = Number(crossTenant.rows[0]!.n);
    correctness.lexicalOrderViolations = lexicalOrderViolations;
    correctness.contextBudgetViolations = budgetViolations;
    correctness.topKViolations = topKViolations;
    correctness.similarityFloorInRoute = 0.70;

    // Query plans for one representative query of each path, at this size.
    const plans: Record<string, unknown> = {};
    plans.lexical_common = nodeTypes(await explain(LEXICAL_SQL, [lexQueries.common[0], tenantA, retrievalLimits.minimumRank, retrievalLimits.maxTopK], tenantA));
    plans.vector_cluster = nodeTypes(await explain(VECTOR_SQL, [tenantA, vecLiteral(vecQueries.cluster[0]!), 'nomic-embed-text', 5], tenantA));
    results.push({ size, loadMs, tenantADocs: docsA.length, sizes: sizeInfo, cells, plans, correctness });
    await clear();
    console.log(`size ${size}: loaded in ${loadMs.toFixed(0)} ms; cells ${cells.length}`);
  }

  const env = { node: process.version, platform: process.platform, arch: process.arch, cpuModel: os.cpus()[0]?.model ?? null,
    cpuCount: os.cpus().length, totalMemoryGiB: Math.round(os.totalmem() / 2 ** 30 * 10) / 10,
    postgresVersion: (await admin.query<{ v: string }>('SELECT version() AS v')).rows[0]!.v, pgvector: ext,
    settings: Object.fromEntries(dbConfig.map((r) => [r.name, r.setting])),
    sizes: SIZES, warmUp: WARM_UP, measured: MEASURED, embeddingModelCalled: false, similarityFloor: 0.70 };
  writeFileSync(outputPath!, `${JSON.stringify({ environment: env, results }, null, 2)}\n`);
  console.log(`wrote ${outputPath}`);
}

main().catch((error) => { console.error(error); process.exitCode = 1; })
  .finally(async () => { await Promise.all([admin.end(), runtime.end()]); });

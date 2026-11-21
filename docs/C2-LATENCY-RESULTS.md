# C2 retrieval latency benchmark: method, results, limits and recommendations

Status: measured on a local disposable PostgreSQL 17 database with synthetic, deterministic data. No embedding model was called.
No live inference, paid service, production database or retrieval policy change was used. The similarity threshold stays at
0.70. C2 remains PARTIAL: these numbers are one environment and one synthetic distribution, not a production qualification.

## What was measured, and what was not

- **Measured:** database retrieval time for three paths, lexical (`retrieveDocumentChunks`), vector (`retrieveByVector`) and
  hybrid (both, plus weighted reciprocal rank fusion), at 4, 500, 1,000 and 5,000 chunks, with tenant-scoped reads through the
  application's own authenticated transaction.
- **Reported separately:** the transaction and authorisation overhead around each call (total minus the function time), and the
  fusion time in memory.
- **Not measured:** embedding generation. A real query embedding is a model call, which was not authorised. The benchmark uses
  seeded synthetic query vectors, so the embedding cost is absent from every number here and must be added separately.
- **Not measured:** cold-cache behaviour, concurrent clients, corpora above 5,000 chunks, memory use beyond the PostgreSQL
  settings listed below, and any other embedding model.

## How it was run

- Script: `apps/api/scripts/retrieval-latency-benchmark.ts`. It is opt-in: it refuses to run unless
  `AEGIS_RUN_RETRIEVAL_BENCHMARK=1`, it refuses non-loopback hosts, and it refuses a database whose name does not end in
  `_bench` or `aegis_test`. It is not part of `npm test` or the CI workflow.
- Corpus: `apps/api/src/retrieval/bench/synthetic-corpus.ts`. Seeded text from a fixed vocabulary, one chunk per document, a
  cluster structure in the embeddings (cluster centres plus seeded noise), and 10% of documents owned by a second tenant.
- Sample: 30 warm-up runs discarded, then 200 measured runs per cell. Queries rotate through 20 distinct queries per type, so the
  steady state is measured (plans and buffers warm). Percentiles are nearest-rank.
- Query types. Lexical: `common` (a high-frequency word), `rare` (a low-frequency word), `multi` (three words from one cluster),
  `none` (no match). Vector: `cluster` (near a cluster centre), `noisy` (near a stored vector), `remote` (random direction),
  `cluster_exact` (the same query with the index disabled for that transaction, as the exact baseline). Hybrid: `cluster_pair`
  (a text query and a vector from the same cluster).
- Correctness, checked in the same run at each size: recall@5 of the default plan against the exact scan over 40 queries; the top-5
  against an in-memory cosine ranking over 10 queries; tenant isolation (no other tenant's chunk, and no cross-tenant embedding
  row, visible); lexical rank order; the context byte budget; and exact top-k.
- Plans: `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)` for one representative query per path at each size. The node types and index
  names are recorded.

## Measured results (generated from the run; raw JSON kept outside the repository)

Environment: PostgreSQL 17.11 (Debian 17.11-1.pgdg12+2); pgvector 0.8.7; host Apple M1 Pro (10 cores, 16 GiB, darwin/arm64); Node v24.22.3. PostgreSQL ran in a local Docker container (pgvector/pgvector:pg17). Settings: shared_buffers=16384 (8 kB pages), work_mem=4096 kB, effective_cache_size=524288 (8 kB pages), max_parallel_workers_per_gather=2, hnsw.ef_search at server default.

Sample: 30 warm-up runs discarded, then 200 measured runs per cell. Percentiles are nearest-rank. A p95 from 200 samples is the 190th value; treat it as indicative, not precise. No embedding model was called. Times are milliseconds.

| path | query type | corpus (chunks) | n | total p50 | total p95 | DB+function p50 | DB+function p95 | transaction overhead p50 | results per query |
|---|---|---|---|---|---|---|---|---|---|
| vector | cluster_exact | 4 | 200 | 6.14 | 10.16 | 2.09 | 3.81 | 4.00 | 4-4 |
| lexical | common | 4 | 200 | 4.06 | 6.17 | 1.40 | 2.44 | 2.60 | 1-3 |
| lexical | rare | 4 | 200 | 4.17 | 6.10 | 1.40 | 2.14 | 2.71 | 0-1 |
| lexical | multi | 4 | 200 | 4.02 | 5.91 | 1.40 | 2.16 | 2.59 | 0-2 |
| lexical | none | 4 | 200 | 4.12 | 6.24 | 1.40 | 2.02 | 2.67 | 0-0 |
| vector | cluster | 4 | 200 | 4.55 | 6.60 | 1.61 | 2.54 | 2.87 | 4-4 |
| vector | noisy | 4 | 200 | 4.75 | 8.11 | 1.72 | 3.09 | 2.99 | 4-4 |
| vector | remote | 4 | 200 | 4.36 | 6.57 | 1.59 | 3.29 | 2.71 | 4-4 |
| hybrid | cluster_pair | 4 | 200 | 5.72 | 7.66 | 2.97 | 4.04 | 2.66 | 4-4 |
| vector | cluster_exact | 500 | 200 | 7.77 | 10.25 | 4.38 | 6.10 | 3.31 | 5-5 |
| lexical | common | 500 | 200 | 5.27 | 8.61 | 2.49 | 3.67 | 2.74 | 5-5 |
| lexical | rare | 500 | 200 | 4.85 | 6.65 | 2.10 | 3.04 | 2.71 | 2-5 |
| lexical | multi | 500 | 200 | 5.26 | 7.71 | 2.39 | 3.33 | 2.83 | 5-5 |
| lexical | none | 500 | 200 | 4.74 | 6.45 | 1.99 | 2.71 | 2.72 | 0-0 |
| vector | cluster | 500 | 200 | 7.00 | 9.38 | 4.10 | 5.08 | 2.87 | 5-5 |
| vector | noisy | 500 | 200 | 6.95 | 9.30 | 4.13 | 5.13 | 2.82 | 5-5 |
| vector | remote | 500 | 200 | 6.97 | 9.66 | 4.10 | 5.61 | 2.84 | 5-5 |
| hybrid | cluster_pair | 500 | 200 | 10.10 | 14.12 | 7.12 | 10.43 | 2.96 | 5-5 |
| vector | cluster_exact | 1000 | 200 | 10.65 | 15.09 | 7.15 | 9.15 | 3.42 | 5-5 |
| lexical | common | 1000 | 200 | 6.12 | 10.84 | 3.37 | 5.99 | 2.66 | 5-5 |
| lexical | rare | 1000 | 200 | 5.55 | 9.80 | 2.74 | 4.34 | 2.71 | 5-5 |
| lexical | multi | 1000 | 200 | 5.88 | 8.05 | 2.91 | 4.35 | 2.84 | 5-5 |
| lexical | none | 1000 | 200 | 5.35 | 10.32 | 2.62 | 3.78 | 2.61 | 0-0 |
| vector | cluster | 1000 | 200 | 9.63 | 12.23 | 6.71 | 8.22 | 2.87 | 5-5 |
| vector | noisy | 1000 | 200 | 9.74 | 12.28 | 6.83 | 8.15 | 2.94 | 5-5 |
| vector | remote | 1000 | 200 | 9.71 | 12.95 | 6.73 | 8.86 | 2.94 | 5-5 |
| hybrid | cluster_pair | 1000 | 200 | 13.25 | 17.96 | 10.01 | 12.88 | 3.06 | 5-5 |
| vector | cluster_exact | 5000 | 200 | 34.46 | 41.62 | 30.61 | 35.56 | 3.66 | 5-5 |
| lexical | common | 5000 | 200 | 11.85 | 17.55 | 8.41 | 13.99 | 3.00 | 5-5 |
| lexical | rare | 5000 | 200 | 6.71 | 9.73 | 3.78 | 5.78 | 2.83 | 5-5 |
| lexical | multi | 5000 | 200 | 6.67 | 11.18 | 3.60 | 6.70 | 2.90 | 5-5 |
| lexical | none | 5000 | 200 | 5.94 | 10.49 | 3.09 | 5.13 | 2.75 | 0-0 |
| vector | cluster | 5000 | 200 | 5.37 | 8.33 | 2.21 | 3.60 | 2.97 | 5-5 |
| vector | noisy | 5000 | 200 | 5.14 | 8.27 | 2.09 | 3.29 | 2.95 | 5-5 |
| vector | remote | 5000 | 200 | 4.63 | 7.01 | 1.95 | 3.15 | 2.65 | 5-5 |
| hybrid | cluster_pair | 5000 | 200 | 8.77 | 17.16 | 5.91 | 13.52 | 2.81 | 5-5 |

Hybrid fusion (in-memory weighted RRF over the two result lists) took p50 0.05 ms at most, so hybrid cost is the two database queries plus overhead.

### Correctness at each corpus size (same run)

| corpus | recall@5 vs exact (40 queries) | identical top-5 (of 40) | default plan used HNSW (of 40) | ranking mismatches vs in-memory cosine (of 10) | tenant-isolation violations | cross-tenant embeddings visible | lexical order violations | context-budget violations | top-k violations |
|---|---|---|---|---|---|---|---|---|---|
| 4 | 0.8 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| 500 | 1 | 40 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| 1000 | 1 | 40 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| 5000 | 1 | 40 | 40 | 0 | 0 | 0 | 0 | 0 | 0 |

At 4 chunks, recall@5 is 0.8 only because there are four candidates for five slots; it is not a retrieval error.

### Query plans (one representative query per path, per corpus size)

- **4 chunks**: lexical Limit > Sort > Result > Nested Loop > Seq Scan > Index Only Scan (memberships_pkey) > Bitmap Heap Scan > Bitmap Index Scan (documents_pkey) > Index Only Scan (memberships_pkey); vector Limit > Sort > Result > Nested Loop > Nested Loop > Seq Scan > Index Only Scan (memberships_pkey) > Bitmap Heap Scan > Bitmap Index Scan (documents_pkey) > Index Only Scan (memberships_pkey) > Seq Scan
- **500 chunks**: lexical Limit > Sort > Result > Nested Loop > Seq Scan > Index Only Scan (memberships_pkey) > Index Scan (document_chunks_tenant_id_document_id_document_version_posi_key) > Index Only Scan (memberships_pkey); vector Limit > Sort > Result > Hash Join > Seq Scan > Hash > Nested Loop > Seq Scan > Index Only Scan (memberships_pkey) > Index Scan (document_chunks_tenant_id_document_id_document_version_posi_key) > Index Only Scan (memberships_pkey)
- **1000 chunks**: lexical Limit > Sort > Result > Nested Loop > Seq Scan > Index Only Scan (memberships_pkey) > Index Scan (document_chunks_tenant_id_document_id_document_version_posi_key) > Index Only Scan (memberships_pkey); vector Limit > Sort > Result > Hash Join > Seq Scan > Hash > Nested Loop > Seq Scan > Index Only Scan (memberships_pkey) > Index Scan (document_chunks_tenant_id_document_id_document_version_posi_key) > Index Only Scan (memberships_pkey)
- **5000 chunks**: lexical Limit > Sort > Result > Nested Loop > Bitmap Heap Scan > Bitmap Index Scan (document_chunks_tenant_id_document_id_document_version_posi_key) > Index Only Scan (memberships_pkey) > Index Only Scan (documents_tenant_id_id_version_source_identity_key) > Index Only Scan (memberships_pkey); vector Limit > Incremental Sort > Result > Nested Loop > Nested Loop > Index Scan (chunk_embeddings_cosine) > Index Scan (document_chunks_pkey) > Index Only Scan (memberships_pkey) > Index Only Scan (documents_tenant_id_id_version_source_identity_key) > Index Only Scan (memberships_pkey)

## What the measurements show

1. **Exact vector retrieval grows with corpus size.** The exact scan (`cluster_exact`) has a database p50 of about 2.1 ms at 4
   chunks, 4.1 ms at 500, 6.7 ms at 1,000, and 30.6 ms at 5,000. It passes about 5 ms somewhere between 500 and 1,000 chunks on
   this hardware. Beyond about 1,000 chunks, the exact path is the wrong default.
2. **The planner switches to the HNSW index, and that makes the vector latency non-monotonic.** At 4 to 1,000 chunks the default
   plan is a sequential scan (exact). At 5,000 chunks, all 40 sampled queries used `chunk_embeddings_cosine`, and the database p50
   fell to about 2.2 ms, below the 1,000-chunk figure. This is a planner decision driven by statistics, not a designed threshold.
   The route's latency therefore depends on which side of the planner's cost estimate the corpus falls.
3. **The approximate index matched the exact top-5 on every sampled query here.** At 500 and 1,000 chunks the default plan was
   already exact, so recall there is trivially 1.0. At 5,000 chunks the default plan used the index for all 40 queries, and recall@5
   was 1.0 with the top-5 identical in 40 of 40 queries. This is evidence for this synthetic, clustered distribution only. Real support
   content, harder queries and a larger corpus could show lower recall. Do not generalise this figure.
4. **Lexical retrieval is fast for rare and missing terms and slower for common terms as the corpus grows.** A rare term stayed at
   about 3.8 ms (database p50) at 5,000 chunks, and a term with no match at about 3.1 ms. A high-frequency term rose from about 2.5 ms
   at 500 chunks to 8.4 ms at 5,000, consistent with longer posting lists. Its p95 at 5,000 chunks was about 14 ms.
5. **Hybrid cost is the two queries plus overhead.** Fusion in memory took well under 0.1 ms at every size, so hybrid adds no
   measurable cost beyond running both queries in one transaction.
6. **The authorisation and transaction wrapper costs about 2.6 to 4 ms per call, and it does not grow with corpus size.** At 4 to
   1,000 chunks this is comparable to, or larger than, the retrieval itself. It is an architectural cost, not a retrieval cost, and
   it is the largest single term for small corpora. Reducing it touches the security boundary (membership and row-level security)
   and needs its own review before any change.
7. **Correctness held at every size tested.** Tenant isolation, cross-tenant visibility, lexical order, the context byte budget
   and exact top-k all show zero violations at 4, 500, 1,000 and 5,000 chunks. The top-5 matched the in-memory cosine ranking on
   every checked query.

## Where performance starts to deteriorate

- Exact vector scans: visible from about 500 chunks, above 5 ms by about 1,000 on this hardware, and about 31 ms at 5,000.
- Lexical common-term queries: rising from 1,000 to 5,000 chunks; the tail (p95) is about 14 ms at 5,000.
- Per-call overhead: flat at about 3 ms, so it limits the small-corpus case regardless of the index.
- Not reached: the HNSW path at 5,000 chunks is about 2 ms (p50), but its behaviour above that, under filtering by many tenants,
  and under concurrency is unmeasured.

## Recommended next improvements (not adopted; each needs measurement and approval)

1. **Make the vector access path explicit at the size the route serves, and validate its recall on realistic data.** The
   planner's switch is data-dependent. An explicit index policy, with recall measured on an independent corpus, would make the
   latency predictable. This changes retrieval behaviour, so it needs approval.
2. **Measure filtered HNSW as the tenant count grows.** A tenant filter applied after an approximate index can return fewer rows.
   pgvector 0.8 offers iterative index scans for this. Measure with many tenants before deciding.
3. **Measure, then reduce, the per-call transaction overhead.** The likely options (short-lived membership caching, or a single
   round trip for membership and retrieval) change the security boundary. Each needs a security review and a separate change.
4. **Bound the common-term lexical tail** (for example, a candidate cap or a stopword policy). This changes ranked results, so it
   needs an evaluation of its effect on answers first.
5. **Extend the measurements:** cold cache, concurrent clients, corpora beyond 5,000 chunks, and the real embedding model's
   latency (which is likely to dominate in production). The embedding measurement needs separate authorisation.

## Limitations

- Synthetic data and seeded vectors. The approximate-index recall figure is specific to this distribution.
- One client, one machine, one Docker VM on Apple M1 Pro. Absolute times will differ elsewhere; the relative shape is the finding.
- Warm cache: the 5,000-chunk corpus fits in the configured shared buffers (128 MB), so disk reads are not in the numbers.
- 200 samples per cell: p95 is the 190th value and varies between runs. Differences smaller than the p95 noise should not be read as
  improvements.
- HNSW parameters were left at the pgvector defaults (m = 16, ef_construction = 64, ef_search = 40); the index options were not
  recorded from the catalog in this version of the script.
- The embedding model, reranking and the similarity threshold were not part of the measurement. The threshold of 0.70 is applied by
  the answer route, not by the retrieval function measured here.

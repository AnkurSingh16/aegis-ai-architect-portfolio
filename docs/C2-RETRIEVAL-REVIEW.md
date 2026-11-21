# C2 retrieval review: what exists, what was verified, what needs approval

Status: development. No live model was run. Any live benchmark, threshold change or production retrieval change needs separate
authorisation. C2 stays PARTIAL.

## Inventory

| Path | Where | What it does |
| --- | --- | --- |
| Lexical | `apps/api/src/documents/retrieval.ts` | Postgres full-text search (`english` configuration, so stemming applies), `ts_rank_cd`, a minimum rank, a top-k limit of 5, and a context byte budget. Ties break on source, version, position and chunk id. |
| Vector | `apps/api/src/retrieval/vector-retrieval.ts`, `ollama-embeddings.ts` | Stored embeddings (`nomic-embed-text`, 768 dimensions, digest pinned), pgvector cosine distance (`<=>`), similarity = 1 - distance, top-k 1 to 20, ties break on chunk id. Tenant scope by row-level security and an explicit tenant filter. |
| Fusion | `apps/api/src/retrieval/ranking-metrics.ts` | Reciprocal rank fusion (k0 = 60) and weighted RRF. Fusion uses ranks only. An id repeated within one list counts once. Ties break on id. |
| Metrics | `apps/api/src/retrieval/ranking-metrics.ts` | Recall@k, reciprocal rank, nDCG@k. |
| Evaluation | `apps/api/src/retrieval/eval/` | Synthetic corpora, query sets, BM25 baseline, a gated lexical candidate (rejected), and Wilson intervals. |

## What this round verified (deterministic, no model)

- **The database vector ranking equals an independent cosine ranking.** `retrieval/vector-ranking-equivalence.integration.test.ts`
  stores seeded synthetic vectors (not model output) and checks, for three query vectors, that pgvector returns the same top-5 order
  and similarities as an in-memory cosine ranking. It also checks tenant isolation (no other tenant's chunk, even for the same query
  vector), exact top-k, and rejection of an out-of-range top-k before any query. Earlier measurements assumed this property without
  checking it. It now holds on a disposable PostgreSQL 17 database.
- **Fusion invariants.** `retrieval/fusion-properties.test.ts` (10 tests): a single list fuses to itself; identical lists fuse to the
  same order; duplicates within a list count once; ties are deterministic; weight 0 orders the vector items as the vector ranking and
  weight 1 orders the lexical items as the lexical ranking (the zero-weight items follow, in a fixed order); weights outside 0 to 1 are
  refused.

## Findings from the review (not changed here)

1. **The lexical path truncates silently.** When the context byte budget is reached, the loop stops and the remaining results are
   dropped without a record. A reader cannot tell that evidence was cut. Reporting the cut is a behaviour change: it needs approval.
2. **The vector path has no similarity floor of its own.** `retrieveByVector` returns the nearest chunks whatever their similarity.
   The floor (0.70) is applied by the answer route, not here. That is correct for the current design, but it means the retrieval
   function alone cannot say "no evidence".
3. **Lexical retrieval is weak on paraphrases, by design.** It matches words, so paraphrased questions score poorly. The recorded
   small-set paraphrase MRR is 0.125 for lexical, against 0.542 for vector.
4. **The fusion weight chosen on the development split is zero.** Weighted RRF with w = 0 is vector-only. Equal-weight fusion
   measured worse on the held-out test split (0.740 against vector 0.931, both recorded in the register).
5. **The reranker and the gated lexical candidate were both rejected** on the measurements recorded in the register. Neither is
   in the code path.

## What is measured, and what is not

Measured earlier (recorded in the register, not repeated here): paraphrase MRR on a small set (lexical 0.125, vector 0.542, hybrid
0.625); a 50-document synthetic corpus (vector MRR 0.882 on paraphrases; 0.931 on the held-out mixed test split); the gated lexical
candidate, which never fired and matched vector exactly.

Not measured: query latency against the database; behaviour beyond 50 synthetic documents; more than one embedding model; any
independently written corpus.

## What needs separate approval

- Any live embedding or benchmark run (model calls).
- Any change to the 0.70 similarity floor.
- Any change to fusion weights, reranking, query reformulation or chunking.
- Reporting of truncated lexical results (finding 1) if it changes a response.
- Any production retrieval change.

## Latency

Measured on a disposable local PostgreSQL 17 with synthetic data at 4 to 5,000 chunks. See `docs/C2-LATENCY-RESULTS.md`.

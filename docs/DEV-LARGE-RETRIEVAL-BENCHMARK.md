# Development benchmark: 50-document synthetic corpus (BM25, vector, hybrid)

Status: **development evidence only**. Engineer-written corpus and queries, one relevant document per query, not human-reviewed, not a production or qualification result. The corpus is NOT ingested into the approved document store, so no source-trust gate was changed.

## Setup
- Corpus: 50 synthetic support documents in 10 topics (`apps/api/src/retrieval/eval/large-dev-corpus.ts`, `aegis-dev-large-retrieval-v1`).
- Queries: 50 paraphrases, one per document. A test enforces that no query shares a content word with its target document.
- Candidate pool: all 50 documents for every query.
- Lexical: BM25 (k1 1.2, b 0.75), lowercase tokens, small stopword list, no stemming (`apps/api/src/retrieval/eval/bm25.ts`).
- Vector: cosine over `nomic-embed-text` (digest `0a109f422b47…`) on loopback Ollama, `search_document:` / `search_query:` prefixes. Bounded: 100 texts in batches of 8, no retries.
- Hybrid: reciprocal rank fusion of the BM25 and vector rankings (k0 = 60).
- Script: `apps/api/scripts/large-retrieval-benchmark.ts`. Raw evidence kept outside the repository.

## Results (50 queries)

| Approach | Mean recall@10 | Mean reciprocal rank | Mean nDCG@10 |
|---|---|---|---|
| BM25 (lexical) | 0.000 | 0.000 | 0.000 |
| Vector (cosine) | 1.000 | 0.882 | 0.910 |
| Hybrid (RRF) | 1.000 | 0.487 | 0.611 |

## What this shows and what it does not
1. **Vector retrieval is strong on paraphrases in this set.** Every target is in the top ten, and the target is first for most queries.
2. **BM25 finds no target by construction.** The queries are paraphrases with no shared target words, so BM25 can never rank the target. The zero is a property of the design, not a measured weakness of BM25 on realistic queries. A fair lexical comparison needs a mixed set that includes queries with real overlap.
3. **Hybrid is worse than vector alone here.** BM25 still returns other documents for many queries, because of incidental shared words, and reciprocal rank fusion gives that noisy list equal weight. This lowers the target's rank. Fusion needs a weight, or a rule that trusts the lexical list only when it is confident.
4. **Recall@10 is saturated** because a 50-document pool and a top-10 cut leave most targets inside the window. The reciprocal rank and nDCG columns carry the signal.

## Limits
- One author, one relevant document per query, synthetic text with a regular style, one embedding model, no repeated runs, no confidence intervals.
- The corpus is a development fixture, not representative of real support content.
- Latency and cost were not benchmarked.

## Next actions
- A mixed query set with graded overlap, so lexical retrieval has a fair chance.
- Weighted fusion, tuned on a held-out split, instead of equal-weight RRF.
- A second embedding model and repeated runs before any comparative claim.

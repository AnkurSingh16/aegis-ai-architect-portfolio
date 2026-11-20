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

## Mixed query set and weighted fusion (held-out)

100 queries: the 50 pure paraphrases, plus 50 augmented versions with 1, 2 or 3 target content words added (`apps/api/src/retrieval/eval/mixed-queries.ts`). The split is by index parity: 50 dev and 50 test. The fusion weight `w` (lexical share in weighted RRF, k0 = 60) was chosen on dev only, over `w` in {0, 0.05, …, 1}. The test split was reported once. Script: `apps/api/scripts/mixed-retrieval-benchmark.ts`.

**Selected weight: w = 0 (vector only).** Every dev weight above zero lowered dev MRR (0.917 at w = 0, 0.753 at w = 0.2, 0.480 at w = 1).

Held-out test (50 queries):

| Approach | MRR | nDCG@10 | Recall@10 |
|---|---|---|---|
| BM25 (lexical) | 0.473 | 0.480 | 0.500 |
| Vector (cosine) | 0.931 | 0.947 | 1.000 |
| Equal-weight RRF | 0.740 | 0.804 | 1.000 |
| Tuned weighted RRF (w = 0) | 0.931 | 0.947 | 1.000 |

By query kind (all 100 queries):

| Approach | Paraphrase MRR | Augmented MRR |
|---|---|---|
| BM25 | 0.000 | 0.920 |
| Vector | 0.882 | 0.966 |
| Equal-weight RRF | 0.487 | 0.960 |

### What this shows
1. **Vector retrieval is the best single approach on this set,** on both kinds of query.
2. **Adding lexical evidence did not help at any weight on dev.** On augmented queries lexical is strong (0.920), but fusing it with vector does not beat vector alone (0.960 at equal weight, 0.966 for vector alone).
3. **The paraphrase result is a construction effect.** Pure paraphrases give BM25 zero, so any fusion weight above zero can only add noise on that subset.

### Limits
- Synthetic, template-like text; keyword augmentation makes the augmented queries artificially easy for BM25.
- One author, one relevant document per query, one embedding model, single run, no confidence intervals. A test split of 50 queries cannot separate close results.
- The selection rule is coarse, and w = 0 is at the boundary of the search range.

# Development measurement: lexical retrieval on paraphrased queries

Status: **development evidence only**. Eight engineer-written queries against the existing synthetic document corpus. Not human-reviewed, not qualified, not a production accuracy claim. The frozen exploratory dataset and its runner were not used.

## Method
- Corpus: the 8 synthetic documents already seeded by the documents integration suite (`apps/api/src/documents/catalog.ts`).
- Retrieval: the existing lexical path, `retrieveDocumentChunks` (`plainto_tsquery` over `search_vector`, rank floor 0.015), run through the authenticated tenant transaction.
- Queries: `apps/api/src/documents/paraphrase-evaluation.ts` (`aegis-dev-doc-paraphrase-v1`). Seven queries deliberately avoid the target document's wording. One control query uses a short phrase with known overlap.
- Metrics: recall@5, reciprocal rank and nDCG@5 from `apps/api/src/retrieval/ranking-metrics.ts`. Relevance is binary.
- Environment: PostgreSQL 17 (pgvector image) in a disposable container, fresh database.

## Results

| Query | Retrieved | Recall@5 | Reciprocal rank | nDCG@5 |
|---|---|---|---|---|
| people cannot get into the app | 0 | 0 | 0 | 0 |
| the second verification step keeps failing | 0 | 0 | 0 | 0 |
| forgot my details and cannot prove who I am | 0 | 0 | 0 | 0 |
| the local server status page does not respond | 0 | 0 | 0 | 0 |
| charged twice for the same plan | 0 | 0 | 0 | 0 |
| the application is slow for everyone | 0 | 0 | 0 | 0 |
| send this to a senior person | 0 | 0 | 0 | 0 |
| control: user-visible error | 1 | 1 | 1 | 1 |

Means over 8 queries: recall@5 0.125, MRR 0.125, nDCG@5 0.125.

## What this shows
1. **Lexical full-text retrieval does not find paraphrases.** It returned nothing for all seven, so the path abstained. This is the case that vector or hybrid retrieval is meant to address.
2. **The rank floor interacts with query length.** A first control query with more terms was ANDed by `plainto_tsquery` and ranked 0.0067, below the 0.015 floor, so it was dropped. Short, lexically close queries pass. Longer queries get no retrieval signal.
3. **The measurement cannot yet compare approaches.** No vector or hybrid run exists, so there is no baseline to beat.

## Limits
- Eight queries, one author, no independent labelling. The results are descriptive, not a statistical comparison.
- Relevance is binary, so nDCG reduces to a rank-weighted recall here.
- This does not measure answer quality or grounding.

## Vector and hybrid retrieval (live, local embeddings)

Model: `nomic-embed-text` (digest `0a109f422b47…`), served by loopback Ollama. Documents use the `search_document:` prefix and queries use `search_query:`. Vectors (768-dimensional) are stored in `aegis.chunk_embeddings` (migration 009) under row-level security. Hybrid retrieval fuses the lexical and vector source rankings with reciprocal rank fusion (k0 = 60). Raw evidence is kept outside the repository.

| Approach | Mean recall@5 | Mean reciprocal rank | Mean nDCG@5 |
|---|---|---|---|
| Lexical (full-text) | 0.125 | 0.125 | 0.125 |
| Vector (cosine) | 1.000 | 0.542 | 0.657 |
| Hybrid (RRF) | 1.000 | 0.625 | 0.719 |

### How to read these numbers
- **Recall@5 is saturated and tells us nothing here.** Each tenant has only four synthetic documents, so the top five always contains all relevant sources. Recall is not a discriminating metric on this corpus.
- **MRR and nDCG are the informative measures**, and they are based on a four-document pool per tenant. The vector ranking's first hit is wrong for several queries. For example, the login paraphrase ranks the network-diagnostics document first.
- Lexical retrieval abstains (returns nothing) on the paraphrases, so its numbers reflect abstention as well as ranking.
- Eight queries, one author, engineer-assigned labels, one embedding model. Treat the gap as a direction, not a result.

### What is not yet established
- Behaviour on a larger corpus, where the candidate pool is much bigger than five.
- Confidence intervals, repeated runs, or a second embedding model.
- Latency and cost. The embedding calls were not timed as a benchmark.
- Answer quality or grounding.

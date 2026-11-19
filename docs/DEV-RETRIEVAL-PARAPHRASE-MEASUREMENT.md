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

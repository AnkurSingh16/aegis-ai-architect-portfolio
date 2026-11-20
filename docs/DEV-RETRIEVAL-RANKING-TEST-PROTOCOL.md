# Retrieval ranking test on the 50-document development corpus (pre-registered, not yet run)

Recorded before any new query is written or any candidate is measured. Nothing here has been run.

## Why this corpus, and what it can and cannot show

The three-document-set attempts (`docs/DEV-C4-RETRIEVAL-SET-V3-PROTOCOL.md`) failed because a four-document North corpus is too
easy: the expected document was first for nine of twelve questions, and the pre-written spares were no harder. The 50-document
development corpus (`apps/api/src/retrieval/eval/large-dev-corpus.ts`, `aegis-dev-large-retrieval-v1`) has more competing
documents. It is the only place in the repository where ranking is measured at a useful size.

It has two limits this protocol must state before any run:

- **Little headroom.** Vector retrieval already gives MRR 0.882 on the paraphrase set and 0.931 on the held-out mixed test
  split (`docs/DEV-LARGE-RETRIEVAL-BENCHMARK.md`). A candidate can gain at most a few points of MRR. With 50 queries, a
  difference smaller than about 8 points in top-one accuracy cannot be told from noise.
- **The existing query sets are spent for this purpose.** The 100 mixed queries were used to choose the fusion weight (dev
  split) and reported on the test split. Their test split cannot now decide a candidate. A new query set is needed.

The corpus is synthetic, one author, one relevant document per query, one embedding model. It is a development fixture, not
evidence about real support content, and nothing here changes the approved document store or any floor.

## The new query set (step 1, before any measurement)

- Fifty new queries, one per document, written before any retrieval is run on them.
- Graded overlap, as in the existing mixed design: twenty-five pure paraphrases (no content word in common with the target
  document) and twenty-five queries that add one to three content words from the target. The overlap count is recorded per query.
- No query repeats wording from the 100 mixed queries or the paraphrases in `large-dev-corpus.ts`. A unit test checks this.
- A test checks that each paraphrase shares no content word with its target, using the same rule as the existing benchmark.
- Same-author. The result must say so.

## Measures (fixed now)

- Top-one accuracy and mean reciprocal rank of the target, over all fifty queries and by overlap group.
- nDCG@10 (one relevant document, so it is a function of rank; reported for comparability with the benchmark).
- Paired bootstrap 95% confidence intervals (10,000 resamples, seed fixed in the script) for the difference between the
  candidate and the baseline. The earlier benchmark reported no intervals; this one must.

## Baseline

Vector retrieval, cosine over `nomic-embed-text` with the same prefixes and digest as the route. Top ten. Measured in the same
run as the candidate, on the same queries.

## Candidate

**None is named here.** A candidate must be pre-registered in its own document before this test is run, stating its aim, the
rank positions it can change, and its acceptance rule. The reranker protocol (`docs/DEV-C4-RERANK-PROTOCOL.md`) is one
possibility, but its rejection was on a set that did not test ranking. It is not evidence about this corpus.

## Acceptance rule (for a candidate, fixed in its own protocol)

A candidate is accepted only if all of these hold, and this section is the minimum:

1. The paired bootstrap 95% interval for the change in MRR excludes zero, in the positive direction.
2. The change does not come only from the augmented queries while the paraphrase group gets worse. Both groups are reported.
3. Latency is measured and reported.

If a candidate fails any condition, it is rejected on this test. No second candidate is run on the same query set.

## Run rules

- One run. The query set, candidate, measures and rule are not changed after any result is seen.
- Local loopback only. No protected inference, no hosted model.
- Raw evidence stays outside the repository. The summary table goes in a results section of this document.

## Limits

- One author, synthetic text, one relevant document per query.
- Headroom is small. A null result is the expected outcome unless the candidate changes rankings a lot.
- Even a positive result on this corpus does not show improvement on real support content. It would justify a test on a
  larger and independently written North corpus, which is a separate protocol.

## Owner decisions this protocol depends on

1. Whether ranking work is worth continuing at all. The route's gaps are the boundary misses below the floor and the answer
   text, not only ranking.
2. Which candidate, if any, to pre-register next.

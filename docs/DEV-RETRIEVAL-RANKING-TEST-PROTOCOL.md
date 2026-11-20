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

## Step 1 done: the 50-query set written (no retrieval run)

- `apps/api/src/retrieval/eval/ranking-queries-v1.ts`: queries R01 to R50, one per document D01 to D50. Odd documents get a
  paraphrase, even documents get an augmented query.
- Written before any retrieval was run on them. Construction checks passed: 25 and 25; paraphrases have zero target content
  words; augmented queries have one to three; no query repeats the mixed set or the paraphrases in `large-dev-corpus.ts`.
- Overlap is computed from the text with the benchmark's stopword list, not typed in.
- Two augmented queries were edited once, to bring their overlap from four to three. That was a construction fix found by
  the overlap test, before any measurement, and it is recorded here.
- Same-author. Step 2 (measurement) is not run. The candidate in
  `docs/DEV-RETRIEVAL-CANDIDATE-GATED-LEXICAL.md` is not implemented or measured.

## Step 2 result: one run, gated lexical candidate against vector baseline (no change to the protocol)

Run once on 2026-11-20 with `apps/api/scripts/gated-lexical-ranking-benchmark.ts` (commit `ace2aed`; candidate in commit `cbbb3c9`).
Model `nomic-embed-text` (digest as in the route), loopback Ollama, 50 queries against the 50-document corpus. Paired bootstrap:
10,000 resamples, seed 20261120. Raw per-query evidence is kept outside the repository.

| Measure | Baseline (vector) | Candidate (gated lexical) |
| --- | --- | --- |
| Top-one, all 50 | 0.90 | 0.90 |
| MRR, all 50 | 0.938 | 0.938 |
| Recall@10, all 50 | 0.98 | 0.98 |
| nDCG@10, all 50 | 0.948 | 0.948 |
| MRR, paraphrase (25) | 0.876 | 0.876 |
| MRR, augmented (25) | 1.000 | 1.000 |
| Promotions by the gate | — | 0 |

- **MRR difference (candidate minus baseline):** 0, 95% paired bootstrap interval [0, 0].
- **Top-one difference:** 0, interval [0, 0].
- **Latency** (BM25 pass plus gate, excluding embedding, per query): median 0.15 ms, maximum 1.38 ms.

### Acceptance rule

1. **Not met.** The MRR interval does not exclude zero in the positive direction. It is exactly zero.
2. **Met, trivially.** The paraphrase group is unchanged. Nothing moved in either group.
3. **Met.** Latency is measured and reported above.

### What the result means

- The gate **never fired** on these 50 queries. The candidate and the baseline give identical rankings.
- This is the null result the protocol predicted. The vector ranking already puts 45 of 50 targets first, and the gate needs a
  near-tie with a confident lexical lead, which did not occur.
- The result does not show that the gate harms ranking. It shows that it did nothing here, so it cannot be credited with any gain.
- Per the run rules, the candidate is rejected on this test. No second candidate is run on this set, and the gate's margin and
  factor are not tuned after seeing the result.
- The result says nothing about real support text. The corpus is synthetic, and the set is same-author.

### Status

Step 2 run. Candidate rejected on this test (rule condition 1 not met; no promotions). The route and its floor are unchanged.

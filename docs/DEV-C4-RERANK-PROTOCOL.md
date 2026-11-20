# C4 retrieval: order-only rerank of the top five (pre-registered, not yet run)

Recorded before any run. No result from a new set has been seen.

## Why

The below-floor analysis (`docs/DEV-C4-BELOW-FLOOR-MISSES.md`) found eight answerable misses. Six had the right document
ranked first but scored 0.646 to 0.694, just under the floor. Two had the wrong document ranked first. A floor change cannot
fix the six boundary misses without admitting unanswerable questions, which the owner has ruled out for now. Only the two
ranking misses are a retrieval problem, so that is the most this change can recover. Recall gain is bounded at about two of
eight misses on the recorded sets.

## The candidate (one only)

- After vector retrieval (top five, unchanged), an order-only rerank: the pinned local model `qwen2.5:3b-instruct` (digest
  `357c53fb659c5076de1d65ccb0b397446227b71a42be9d1603d46168015c9e4b`, temperature 0, loopback Ollama) is asked which single
  source best answers the question. The chosen source moves to rank one. Other items keep their order.
- Scores are not changed, so the 0.70 floor applies exactly as before.
- No other change: same embeddings, same top five, same loop, same answer prompt (v4 in the route; the answer prompt is not
  part of this test).

## The set

A new labelled set, `retrieval-rerank-v1`, written before the run. Twelve answerable questions chosen so the expected
document is in the top five but not first, plus twelve unanswerable questions. It must share no wording with any earlier
set (a unit test will check this). Same-author; that limit is stated in the result.

## Measures

- Top-one accuracy: share of answerable questions where the expected document is ranked first, before and after rerank.
- Mean reciprocal rank over the answerable questions, before and after.
- False answers and wrong-source answers, after rerank, when the answer loop runs with the floor.
- Latency per question, reported as measured. Not estimated.

## Acceptance rule (fixed before the run)

Accept the change only if all of these hold:

1. Top-one accuracy after rerank is higher than before on the set.
2. Zero false answers and zero wrong-source answers after rerank.
3. Latency is reported. It is not a pass or fail condition here, but the owner must see it before any route change.

Otherwise, reject it and record the result as it stands. No second candidate is run on this set.

## Run rules

- One run of the set. No change to the candidate, the set or the rule after the run.
- Local loopback only. No protected inference, no hosted model.

## Known limits

- Same-author set; one run; twelve answerable questions, so one question moves top-one accuracy by about 8 points.
- A three-billion-parameter reranker. It may be wrong in ways a larger model is not.
- The candidate does not touch the six boundary misses. Passing this rule does not show the floor is right.

## Implementation (recorded before the run)

- Reranker: `apps/api/src/rag/ollama-reranker.ts`, prompt `rr1`, pinned model as above, temperature 0, 32 output tokens. A
  reply that is not exactly one retrieved source id (brackets allowed) keeps the order and is reported as `unparsed`.
  A service failure keeps the order and is reported as `failed`. Outcomes are counted in the report.
- Set: `apps/api/src/rag/retrieval-rerank-cases-v1.ts`. Its rank position is not checked before the run; the run reports each
  question's actual rank of the expected document, before and after rerank.
- Runner: `apps/api/src/rag/retrieval-rerank.integration.test.ts`, gated by `AEGIS_LIVE_OLLAMA=1`, writing to
  `C4_RERANK_OUTPUT`. It runs raw and reranked retrieval on the same retrievals, so the comparison is paired.
- Safety: the answer loop with the route's policy (`ANSWER_POLICY`, including the answer-text guard) and the answer prompt
  v4, on the reranked order. The route's prompt is the one measured, because it is the one that would ship.
- Measures reported: top-one accuracy and mean reciprocal rank before and after, outcome counts, rerank latency (median and
  maximum, measured), and the safety report from the scorer.

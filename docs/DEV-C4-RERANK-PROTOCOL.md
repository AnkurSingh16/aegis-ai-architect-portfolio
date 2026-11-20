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

## Result (one paired run, set retrieval-rerank-v1)

Run on 2026-11-20 with `C4_RERANK_OUTPUT` set. Model `qwen2.5:3b-instruct` (pinned digest), rerank prompt `rr1`, answer prompt
v4 with the route policy. The protocol above was not changed before or after the run.

| Measure | Raw order | Reranked |
| --- | --- | --- |
| Top-one accuracy (answerable, 12) | 10 of 12 | 10 of 12 |
| Mean reciprocal rank (answerable) | 0.903 | 0.917 |

- Rerank outcomes over 24 questions: 7 moved, 9 kept, 8 unparsed, 0 failed.
- Rerank latency, measured on this machine: median 882 ms, maximum 3311 ms.
- Safety (answer loop, route policy, reranked order): 5 of 12 answerable answered correctly, 0 wrong-source answers,
  0 false answers, 7 false abstentions. Abstention precision 0.63. Four of the seven false abstentions were round-one guard
  failures (`reformulation_unavailable`, with reformulation off); three had no usable evidence (`insufficient_evidence`).

### Decision rule

- **Acceptance condition 1 (top-one accuracy higher after rerank): not met.** It is the same, 10 of 12.
- **Acceptance condition 2 (zero false and zero wrong-source answers): met.**
- **Acceptance condition 3 (latency reported): met.**

**The candidate is rejected under the rule.** The route is not changed. No second candidate is run on this set.

### What the run shows

- **The set did not test what it was built to test.** The protocol said the expected document would be in the top five but
  not first. In fact ten of twelve were already first in the raw order. The set design was not checked before the run,
  and the protocol said it was not. The run therefore could not show a ranking gain, even if one existed.
- **Four answerable questions changed rank.** Two improved: `rr1-answer-mfa-status-page` (2 to 1) and
  `rr1-answer-recovery-named` (3 to 1). Two got worse: `rr1-answer-network-record` and `rr1-answer-network-health` (1 to 2).
  Top-one accuracy is unchanged because the gains and the losses cancel. This is too small to read as a trend.
- **Eight of the 24 rerank replies were unparsed.** All eight were on unanswerable questions, where the reply does not affect
  the decision. The 3B model did not reliably return a single source id.
- Recall on this set (5 of 12) is not comparable with the earlier sets. It is a different set, and this is one run.

### What would be needed for a new candidate

A fresh set whose expected documents are verified before the run to sit outside the first position, and a new protocol that
records that check. Any new candidate also needs its own pre-registration. Nothing here argues for or against a reranker in
general.

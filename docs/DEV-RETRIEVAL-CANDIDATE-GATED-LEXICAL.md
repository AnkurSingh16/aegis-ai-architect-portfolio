# Candidate: gated lexical promotion over vector ranking (pre-registered, not yet run)

Recorded before the query set in `docs/DEV-RETRIEVAL-RANKING-TEST-PROTOCOL.md` is written, and before any candidate is measured.

## Why this candidate

The benchmark found that equal-weight fusion hurts, because BM25 returns noisy lists with incidental shared words. Its own next
action was to trust the lexical list only when it is confident. This candidate does that, and only that. It changes the
ranking only when vector retrieval is nearly tied and lexical retrieval points clearly at one document. It does not fuse the
two lists, and it does not change scores, so the floor is unaffected.

## The rule (all parameters fixed now, none tuned on the new set)

Inputs for one query: the vector ranking (cosine, top ten) and the BM25 ranking over the same 50 documents.

1. Let `v1` be the top vector document, with cosine `c1`. Let `L` be the top BM25 document, with BM25 score `b1`, and `b2` the second BM25 score.
2. Promote `L` to rank one only if **all** of these hold:
   - `L` is in the vector top ten, and its cosine `cL` satisfies `c1 - cL <= 0.02`. This is the near-tie condition.
   - `b1 >= 2 * b2`, and `b1 > 0`. This is the lexical-confidence condition.
   - `L` is not already `v1`.
3. If promoted, `L` moves to the front. All other documents keep their vector order.
4. Otherwise the vector ranking is returned unchanged.

Only one document can move, and only to rank one. Documents below the top are never reordered.

## What it can change, and what it cannot

- It can change top-one accuracy, only where the target is the vector runner-up or lower within 0.02 of the top, and BM25 is confident about it.
- It cannot change recall@10 on the set. It can only reorder within the top ten.
- It cannot raise any score, so it cannot affect the 0.70 floor or any abstention.
- On the paraphrase group, BM25 has no overlap, so the lexical condition should rarely hold. The augmented group is where it can act.

## Acceptance rule

Acceptance is governed by `docs/DEV-RETRIEVAL-RANKING-TEST-PROTOCOL.md`, with its three conditions:

1. The paired bootstrap 95% interval for the change in MRR, against vector retrieval, excludes zero in the positive direction.
2. The change is not only from the augmented group while the paraphrase group gets worse. Both are reported.
3. Latency is reported. The added cost is one BM25 pass over 50 documents, measured, not estimated.

## Predictions, written before the run

- The expected effect is small, and a null result is likely. The vector ranking already puts most targets first, so there is little
  near-tie to resolve.
- If the rule promotes a document, it should be a target more often than not on the augmented group. If it is not, the rule is
  rejected on the test even if MRR moves.

## Limits

- One author. The 0.02 margin and the factor 2 are my choices, not measured optima. They are fixed here and are not to be tuned
  on the new set.
- The result cannot show that the rule works on real support text. It is a development fixture.
- This is not a fusion weight. The earlier weighted-fusion search already selected w = 0 on the dev split, and this candidate
  does not reopen that choice.

## Status

Named and pre-registered. Not implemented as a module. Not run. The query set in the ranking protocol has not been written yet.

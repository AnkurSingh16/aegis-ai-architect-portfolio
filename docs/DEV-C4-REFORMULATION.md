# C4 reformulation test (pre-registered, not yet run)

Recorded before any run. No result from this set has been seen.

## Motivation

The below-floor analysis (`docs/DEV-C4-BELOW-FLOOR-MISSES.md`) found six answerable misses where the right document was
ranked first but scored just under 0.70. The loop never retried those cases: when no item reached the floor, it abstained
at once, before `reformulate` could run. This protocol tests whether one reworded query, tried when the first round finds
no usable evidence, recovers answerable questions without admitting unanswerable ones.

## The change under test

Three things change together, and only together:

1. **Loop option** `retryOnInsufficientEvidence: true`. When a round has no evidence at or above the floor, and rounds remain,
   the loop asks `reformulate` for one new query and tries again. Off by default, and unit-tested
   (`apps/api/src/rag/self-correcting-reformulation.test.ts`).
2. **Reformulator** `r1` (`apps/api/src/rag/ollama-reformulator.ts`). The same pinned local model as the generator
   (`qwen2.5:3b-instruct`), temperature 0, one line out, at most 15 words in the instruction and 200 characters accepted.
   It returns null when it has nothing usable. Its prompt is fixed.
3. **Set** `generatorEvalCasesV6` (`apps/api/src/rag/generator-cases-v6.ts`). Twelve answerable, paraphrased to share few
   exact words with the documents, and twelve unanswerable (six off-topic, six South-domain). A unit test checks that no
   question repeats an earlier set.

Fixed and unchanged: the generator prompt (v4), the floor (0.70), retrieval (vector, `nomic-embed-text`, top 5), and
`maxRounds: 2`.

**Author:** the pipeline's author wrote the set. It is same-author, not independent. Its questions are paraphrased on
purpose, so it tests the retry on the kind of question that missed before. That also makes it a harder-than-usual test for
the retry, not a neutral sample.

## Two runs, each once, on the same set

- **Run A (baseline):** `C4_GENERATOR_RUN=v4 C4_GENERATOR_SET=v6`, reformulation off. This is the current loop on set v6.
- **Run B (reformulation):** the same, with `C4_LOOP_REFORMULATE=1`.

Each run is one pass. Neither is repeated. The baseline is needed to tell a change from the set's own difficulty.

## Reported for each run

- Answer recall, wrong-source answers, false answers and abstention precision (from the scorer), with counts.
- `no_citation` rejections, and generation failures. Reformulator failures count as generation failures.
- For run B: how many cases triggered a retry, how many were then answered, and for each answered retry whether it was
  correct, wrong-source or a false answer. The per-case records show this.

## Decision rule (fixed before the runs)

- **Safety rule:** run B has zero false answers and zero wrong-source answers.
- **Citation rule:** run B has zero `no_citation` rejections and zero generation failures.
- **Recall gain** is the difference in answer recall between run B and run A. It is reported, and it counts only if the
  safety rule and the citation rule both hold in run B.
- The reformulation option is **accepted** for the answer loop only if both rules hold and recall in run B is higher than
  in run A. Otherwise it is not accepted, and the default stays off.
- A result is reported as it stands. No change to the reformulator prompt, the floor or the set after the runs.

## Why the safety rule matters more here

A retry sends a second query. A reworded query can pull a South-domain or off-topic document above the floor. Run A
abstains on those. Run B could answer them, and that would show up as false answers. The rule is written so that a recall
gain is never enough on its own.

## Known limits

- Same-author set, one run each, twelve answerable questions. One question moves recall by about 8 points.
- The reformulator is a three-billion-parameter model. Its rewrites are not graded for quality; only their effect on the
  scored outcomes is measured.
- The retry uses the same floor. This protocol does not test a floor change.
- The earlier sets and their results remain on record and are not re-run.

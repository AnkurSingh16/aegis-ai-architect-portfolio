# C4 similarity floor, round four (pre-registered, not yet run)

Recorded before any run. No score from this round has been seen.

## Why this round

The floor has been chosen twice and tested on two holdouts, and both holdouts are spent. The below-floor analysis
(`docs/DEV-C4-BELOW-FLOOR-MISSES.md`) showed that answerable misses and unanswerable scores overlap in the 0.66 to 0.69
band. This round asks the boundary question on fresh questions, with a larger calibration set than before.

## The sets

- **Calibration v4** (`calibrationCasesV4`, `apps/api/src/rag/floor-cases-v4.ts`): 20 answerable (five per North document)
  and 20 unanswerable (10 off-topic, 10 South-domain). Used only to choose the floor.
- **Holdout v4** (`holdoutCasesV4`): 12 answerable (three per North document) and 12 unanswerable (six off-topic, six
  South-domain). Used once, at the floor the calibration chose.
- A unit test checks the shape and that no question repeats wording from any earlier set.

**Author:** the pipeline's author wrote both sets. They are same-author, not independent. The earlier independent-set run
(`docs/DEV-C4-INDEPENDENT-SET.md`) used a fresh author, and that route is open for a later round if wanted.

## Fixed inputs

- Retrieval: vector, `nomic-embed-text` (digest pinned), top 5, over the North tenant.
- Floor candidates: 0.50 to 0.80 in steps of 0.01, as in every earlier round.
- Rule: maximise answer recall minus false-answer rate; ties go to the higher floor; tolerance 1e-9
  (`apps/api/src/rag/floor-calibration.ts`). Unchanged.
- Holdout run: the real loop, `maxRounds: 2`, `reformulate` returns null, and the same stub generator as earlier rounds.
  The sweep must agree with the real loop case by case, and the test asserts this.

## Run rules

- **One run.** The integration test chooses the floor on calibration v4, then runs holdout v4 once through the real loop.
- **No changes after the run.** The rule, candidates, sets and loop are fixed. The chosen floor is not changed afterwards.
- **Reported:** the calibration sweep, the holdout sweep, the holdout real-loop counts (answer recall, false answers,
  wrong-source answers, abstention precision), and each holdout case with its top score.

## Decision and stop condition (fixed before the run)

- The floor the rule chooses on calibration v4 is the **candidate floor**. It is reported with its holdout result.
- The candidate floor is **accepted for the current corpus** only if the holdout has zero false answers and zero
  wrong-source answers. Recall is reported and is not part of this rule.
- If the holdout has a false answer, the candidate floor is not accepted, and the floor stays unsettled. The result is
  reported as it stands. No second floor is tested on this holdout.
- The owner decides what to do with an accepted or rejected candidate, as with round two and round three.

## Known limits

- Same-author sets, one calibration pass and one holdout run. Each holdout question moves recall by about 8 points.
- The result applies to the current synthetic corpus and the local embedding model only.
- Retrieval scores only. The generator and the loop's citation checks are not part of the floor decision.
- The earlier sets and their results remain on record and are not re-run.

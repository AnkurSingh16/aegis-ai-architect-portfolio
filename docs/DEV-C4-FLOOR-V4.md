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

## Result (one run, as pre-registered)

Run once: floor chosen on calibration v4 with the fixed rule, then holdout v4 run once through the real loop at that floor.
All cases completed, and the holdout sweep agreed with the real loop case by case.

**Calibration v4** (20 answerable, 20 unanswerable). Floors 0.63, 0.64 and 0.65 each score 0.900 on recall minus false-answer
rate (recall 18 of 20, false answers 0 of 20). The rule breaks ties toward the higher floor, so the rule chooses **0.65**.
At 0.70 on calibration, recall falls to 13 of 20 (0.650), so 0.70 is not the rule's choice on this set.

**Holdout v4 at 0.65, real loop** (12 answerable, 12 unanswerable): answer recall **12 of 12 (1.000)**, false answers
**0 of 12**, wrong-source answers **0**, abstention precision **1.000**.

**Acceptance rule, applied as written:** the candidate floor 0.65 has zero false answers and zero wrong-source answers on the
holdout, so it is **accepted for the current corpus**, as the protocol defined that outcome.

**Holdout sweep, for reading only:**
- 0.64 to 0.68: zero false answers, recall 1.000.
- 0.63: one false answer. 0.60 to 0.62: two or three false answers.
- 0.70: recall 7 of 12 (0.583), zero false answers.

**Holdout margins:** the lowest answerable top score was 0.684 (`floor4h-answer-mfa-automated`), and the highest unanswerable
top score was 0.634 (`floor4h-abstain-south-notice`). The gap between them is small (0.05 wide), and it sits on one author's
12 questions.

**What this does and does not settle:**
- The owner set the floor at 0.70 earlier. This round supports 0.65 on fresh questions, but it does not replace 0.70 in the
  code. Changing the floor is the owner's decision.
- The sets are same-author, so this result is weaker than an independent set would be.
- The calibration set had two answerable misses below 0.65, so the rule's recall is 0.90, not 1.00.

The report is kept in the scratchpad (`c4-floor-v4-run1.json`), not in the repository.

## Owner decision: keep 0.70

The owner decided to keep the similarity floor at 0.70, and not to move it to the 0.65 candidate. Reasons, as given in the
review: 0.70 has produced zero false answers on every set measured; 0.65 let false answers through on the second calibration
set (2) and 0.66 on the second holdout (1); the 0.65 result rests on one calibration set and one same-author holdout; and a
false answer costs more than an abstention. The cost is recall (7 of 12 on holdout v4 at 0.70). The code is unchanged.

Revisit only with an independently written calibration and holdout set where a lower floor holds with zero false answers.

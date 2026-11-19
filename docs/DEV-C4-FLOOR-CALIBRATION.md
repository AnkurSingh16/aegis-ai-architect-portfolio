# C4 similarity floor: calibration and holdout (development)

## Why
The vector floor of 0.5 answered 4 of 7 unanswerable questions in the first live run. Choosing a floor from those same 15
labels would be tuning on the evaluation. This run uses separate sets.

## Sets (written before any live run)
- **Calibration** (`apps/api/src/rag/floor-cases.ts`, `calibrationCases`): 10 answerable North questions and 10
  unanswerable ones (5 off-topic, 5 whose support is only in the South tenant). Used only to choose the floor.
- **Holdout** (`holdoutCases`): 8 answerable and 8 unanswerable, same kinds. Used once, with the chosen floor. It is
  not used to choose anything.
- The original 15 (`abstentionCases`) are reported for reference only. They have been observed, so they are not clean.

## Rule, fixed before the run
- Candidate floors: 0.50 to 0.80 in steps of 0.01.
- Objective on calibration: maximise answer recall minus false-answer rate. A null rate counts as 0.
- Tie: the higher floor.
- The chosen floor is then applied once, through the real loop, to the holdout. The sweep and the real loop must agree,
  and the test asserts that.

## Result
(Recorded after the run.)

## Result (one live run, fresh disposable PostgreSQL 17, local embeddings)

**Chosen floor: 0.70.** Calibration sweep (answer recall, false-answer rate):

| Floor | 0.50 | 0.55 | 0.60 | 0.65 | 0.70 | 0.75 | 0.80 |
|---|---|---|---|---|---|---|---|
| Recall | 1.0 | 1.0 | 1.0 | 1.0 | 0.9 | 0.6 | 0.1 |
| False answers | 0.7 | 0.6 | 0.5 | 0.1 | 0 | 0 | 0 |

0.65 and 0.70 both score 0.9 on recall minus false-answer rate. The fixed tie rule picks the higher floor, 0.70.

**Holdout, real loop at 0.70, tested once:**
- Answer recall 7 of 8 = 0.875. Wrong-source answers 0.
- False answers 0 of 8 = 0. All 8 unanswerable questions abstained, including the 4 cross-tenant ones. The highest
  unanswerable top score was 0.626.
- Abstention precision 8 of 9 = 0.889.
- The one miss was `hold-answer-recovery-secrets`: its top score was just under 0.70 and it abstained.
- The sweep and the real loop agreed on every holdout case; the test asserts this.

**Original 15 cases at 0.70 (reference only; these were already seen, so they are not clean):** recall 7 of 8, false
answers 0 of 7, abstention precision 7 of 8. The earlier 0.5 floor was 8 of 8 recall with 4 of 7 false answers.

## What this supports and what it does not
- Supports: on a separate calibration set, a floor of 0.70 with the fixed rule answers no unanswerable question and
  answers 9 of 10 answerable questions, and it held on one holdout run.
- Does not support: a general floor. Both sets are small (10 and 8 answerable cases), each was written by one author,
  and the floor sits close to the edge of the answerable scores, so one question shifts recall by 12 points. The
  boundary is sensitive. A larger, independently written set is needed before the floor is treated as settled.
- The holdout was run once, after the floor was fixed. Any later change to the floor would need a new holdout.

## Second round (pre-registered before the run)
- **Calibration v2** (`calibrationCasesV2`, `apps/api/src/rag/floor-cases-v2.ts`): the first calibration set plus 12
  answerable and 12 unanswerable additions. 22 answerable and 22 unanswerable in total. Used only to choose the floor,
  with the same rule and the same candidates (0.50 to 0.80).
- **Holdout v2** (`holdoutCasesV2`): 12 answerable and 12 unanswerable, fresh. Used once, with the floor chosen from calibration v2.
- The first holdout and the original 15 are reference only.
- Still one author. The additions are not independent of the first round or of the corpus wording.
- Recorded here before the run: the rule, the sets and the run count (one).

## Second round result (one live run)

**Calibration v2, exact counts** (answerable correct / unanswerable false answers): 0.65 gives 21/22 and 2/22; 0.66 gives
21/22 and 1/22; 0.68, 0.69 and 0.70 each give 20/22 and 0/22. As fractions, 0.66, 0.68, 0.69 and 0.70 all score 20/22
on recall minus false-answer rate. The rule breaks ties toward the higher floor, so the rule gives **0.70**.

**What the run actually did:** the code chose **0.66**. Floating-point arithmetic put 0.66 one unit above the others,
so the tie was missed. This is a bug in the tie check, not a result. It is fixed in `floor-calibration.ts` (tolerance
1e-9), with a unit test built from the same case (`chooseFloor exact ties`).

**Holdout v2, through the real loop at the code's choice (0.66), run once:**
- Answer recall 11 of 12 = 0.917. Wrong-source answers 0 (one false answer and no wrong-source answers are reported above).
- False answers 1 of 12 = 0.083. The miss was `hold2-abstain-south-degraded-review`, a South question, answered from a
  North document with top score 0.665.
- Abstention precision 11 of 12.

**The same run's holdout sweep at the rule's floor (0.70):** 9 of 12 answerable correct (recall 0.75) and 0 of 12 false
answers. That number is in the output of this run, so it has now been seen.

**The holdout is spent.** It has been used to inspect two floors, so it is no longer clean for choosing one. The gated
test will rerun the same holdout if run again. Any further decision needs a new holdout.

**Decision still open.** The rule, applied correctly, gives 0.70: no false answers, recall 0.75 on this holdout. The code
gave 0.66: recall 0.92, one false answer. Both are inside the uncertainty of sets this small. The owner should choose,
or a new holdout should settle it.

## Third holdout (pre-registered before any run)

Recorded before the run, from the code as committed, with no score from this holdout seen.

- **Floor chosen:** 0.70. This is the fixed rule (maximise answer recall minus false-answer rate, ties to the higher
  floor, tolerance 1e-9) applied to `calibrationCasesV2`, the set already used to choose in the second round. The code's
  earlier 0.66 came from the float bug, not from the rule, so 0.70 is the rule's answer.
- **Holdout v3** (`holdoutCasesV3`, `apps/api/src/rag/floor-cases-v3.ts`): 12 answerable (three per North document) and 12
  unanswerable. Six unanswerable are off-topic. Six are South-domain questions, which the North tenant must not answer.
  Fresh: a unit test checks that no question wording repeats any earlier calibration or holdout set.
- **Run count: one.** The gated integration test now points at `holdoutCasesV3`. It runs the real loop once at 0.70.
- **Stop condition, written now:** the reported counts are the result. The floor is not changed after seeing them. If
  there is any false answer at 0.70, the floor is not accepted for C4 and the register keeps the floor unsettled. If there
  are none, the result still supports only this holdout, because the author is the same and the sets are small.
- **Known limit:** the South-domain negatives are written as close to the boundary as one author can make them, but they
  are still one author's judgement of what is "close". Recall on twelve questions moves about 8 points per question.

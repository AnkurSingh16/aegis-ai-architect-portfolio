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

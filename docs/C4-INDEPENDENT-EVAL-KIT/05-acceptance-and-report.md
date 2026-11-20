# Acceptance criteria and report (for the owner and the reviewers)

## Minimum safety requirements (non-negotiable)

- Zero observed false answers (an answer to an unanswerable question).
- Zero observed wrong-source answers (an answer citing a document that does not support it).
- No answer that only repeats the question.
- No citation-only or placeholder answer.

Zero observed failures does not prove a zero failure rate. Every rate is reported with a Wilson 95 percent interval
(`apps/api/src/retrieval/eval/wilson-interval.ts`).

## Quality measures, reported separately

| Measure | Denominator | Source |
| --- | --- | --- |
| Source correctness | answered items | human reviewer |
| Responsiveness (addresses the question) | answered items | human reviewer |
| Completeness (key points present) | answered items | human reviewer, against the labelled key points |
| Hallucination (unsupported claim) | answered items | human reviewer |
| Question echo | answered items | human reviewer; also the automatic echo check, reported separately |
| Source copying (longest verbatim span) | answered items | automatic, reported, not a rejection |
| Retrieval failure (correct document not first, or below floor) | answerable items | automatic ranks and scores, plus reviewer |
| Abstention correctness | all items | automatic, checked by reviewer |
| Citation problem (unknown or missing citation) | answered items | automatic guard |
| Answer recall | answerable items | automatic |
| Abstention precision | abstained items | automatic |

Automatic results must never be presented as human-validated. The report states which measures are human and which are
automatic.

## Report layout

1. The locked manifest: corpus version, set hashes, floor, model and digest, prompt version, date.
2. Counts: items, answered, abstained, generation failures.
3. Safety results with intervals.
4. Each quality measure with its denominator and interval.
5. Every item with a safety failure or a quality failure, listed by id, so a reader can open it.
6. Limitations, including the author's and reviewer's independence as stated, and what was not measured.

## Acceptance for a stronger quality claim

All of the following, on the locked final holdout, run once:

- Minimum safety requirements met.
- Responsiveness and completeness reported with intervals, and the owner has stated what rate they accept.
- Independent authorship and review confirmed in writing by the owner.
- The floor was chosen on the calibration set only, by the rule fixed beforehand.

Until all of these hold, the 0.70 floor is an owner-approved conservative threshold supported by development evaluations,
not an independently qualified threshold.

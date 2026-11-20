# C4 question-echo check, version 2: change, success and measurement (recorded before any evaluation)

Status: development only. The answer route does not call it. No evaluation of v2 has been run. The v8 cases used below are
regression checks, not evidence.

## What is changing (exactly)

Version 1 (`apps/api/src/rag/question-echo.ts`, `echo-v1`) is kept unchanged. Its tests still pass.

Version 2 (`apps/api/src/rag/question-echo-v2.ts`, `echo-v2`) differs as follows.

| Aspect | v1 | v2 |
| --- | --- | --- |
| Unit of decision | the whole body | each sentence |
| Question sentences (ending in `?`) | counted as words | recognised as questions; an answer made only of questions is an echo (`question_only`) |
| Statement restating the question | every body word must be in the question | every content word must be in the question, after function words and light suffix stripping, with at least three content words (`restated`) |
| Negation | not treated specially | negation words are always content words, so "does not" cannot match a question without it |
| Short answers ("Yes", "No") | not flagged (fewer than three words) | not flagged, and any responsive sentence makes the answer non-echo |
| Restatement followed by a responsive sentence | not flagged | not flagged |
| Reason reported | none | `no_text`, `answer_present`, `question_only` or `restated` |

v2 does not judge truth, completeness or source support. A non-echo answer is not thereby correct.

## What success looks like

Success is judged on a labelled set of answers, each marked by a human reviewer who is not the author of v2, as either
"echo" (the answer only repeats the question) or "not echo" (the answer contains anything beyond the question, including a
responsive short answer). The labels come from the independent evaluation kit (`docs/C4-INDEPENDENT-EVAL-KIT/`), not from the
pipeline.

Success requires, on that labelled set:

- **Zero false positives on answers the reviewer marks responsive.** A responsive answer flagged as an echo is a rejected
  good answer. This is the most important error, and the owner asked for the check to prefer acknowledging limits to
  rejecting good answers.
- **False negatives reported, with interval.** An echo the check misses is counted and reported, and it is not a failure of
  the check's promise, because v2 documents that paraphrased statement echoes are not caught.
- The reason category is consistent with the label on every item (no `answer_present` on an echo, no `question_only` on a
  responsive answer).

## How false positives and false negatives are measured

- **False positive (FP):** an answer labelled "not echo" by the reviewer, for which v2 returns `echo: true`.
  Reported as a count out of all "not echo" labels, with a Wilson 95 percent interval (`apps/api/src/retrieval/eval/wilson-interval.ts`).
- **False negative (FN):** an answer labelled "echo" for which v2 returns `echo: false`.
  Reported as a count out of all "echo" labels, with a Wilson 95 percent interval.
- Both are reported by reason category, so the reader can see which limit caused which error.
- No threshold is tuned on the labelled set. The rule is fixed as written above.

## Regression on the v8 cases (not evidence)

The owner's review labelled the seven v8 answers. v2 is checked against those labels only as a regression:

- `gen8-answer-login-one-account` and `gen8-answer-recovery-name-proof`: echo, reason `question_only`. Expected: flagged.
- The other five answered cases: not echo. Expected: not flagged.

These seven are not an evaluation. They are the same answers the v1 check was designed around, so they cannot show that v2
generalises. The regression tests are in `apps/api/src/rag/question-echo-v2.test.ts`.

## Known limits (recorded, and tested as limits)

- A paraphrased statement echo that adds new words is not flagged. Example: "The name in a case description is not enough to
  prove identity" is not flagged, although it is a statement, not an echo, and whether it answers the question is a human
  judgement.
- A real instruction whose words all come from the question is flagged (known false positive).
- Two-word restatements are not flagged, because the three-content-word minimum is deliberately conservative.
- Stemming is light and rule-based. Words with irregular forms may not match, which causes false negatives, not false positives.

## Decisions taken with this protocol

- v2 stays development-only and is not wired into the route.
- Wiring v2 into the route needs a separate candidate evaluation on a labelled set, and an owner decision.
- v1 is kept for reproducibility of any earlier result.

# C4 independent evaluation: brief for the independent author

Status: brief only. No questions, labels or results are in this document. The evaluation set must be written by a person
who did not develop the retrieval pipeline, the prompts, the North corpus or the v8 set. Nobody on the pipeline may write
or edit the questions. This brief tells that person what is needed and what they must not see.

## What the evaluation is for

To test whether the route's answers, at the owner's 0.70 similarity floor, are responsive, supported and correctly withheld,
on a corpus and questions the pipeline did not write. It is not a demonstration. Its result is reported whatever it shows.

## What the independent author receives

- The corpus brief: the subject area, the audience, and the length and style of documents. Not the existing North documents.
- The output format below and the labelling rules.
- The pre-registration template (`docs/DEV-C4-ANSWER-QUALITY-V8-PROTOCOL.md` shows the structure, not the questions).

## What the independent author must not receive

- Retrieval scores, rankings or floor values.
- Any model answer, including the v5, v4 or v8 answers.
- The v8 set, the earlier generator sets, or the holdouts.
- The pipeline's prompts.

## Size and mix (fixed before the run)

- At least 40 answerable and 40 unanswerable questions in the final holdout.
- A separate calibration set, used only to choose the floor rule.
- Answerable questions in natural wording, not copied from the document.
- Unanswerable questions in three kinds:
  - same-domain near-misses, where the document covers the topic but not the question;
  - questions about information that is not in any document;
  - unrelated questions.
- Restricted-source cases: questions about material the route must not use, with the expected outcome stated.

## Labels

Each item records:

- `id`, `question`, `kind` (`answerable` or `unanswerable`);
- for answerable items, the supporting document id and the sentence that supports the answer;
- for unanswerable items, the reason it is unanswerable;
- `author` and the date written.

## Pre-registration

Before any run, the independent author and the owner fix and record:

- the corpus version, the question list and the labels;
- the metrics and the acceptance criteria;
- the retrieval configuration and the floor-selection rule;
- that the final holdout is run once.

## Acceptance criteria (minimum, from the owner's review)

- Zero observed false answers and zero wrong-source answers.
- No answer that merely repeats the question.
- No citation-only or placeholder answer.
- Answer recall and abstention precision reported with confidence intervals.
- The false-answer rate reported with a confidence interval. Zero observed failures does not prove a zero failure rate.
- Incomplete and unsupported responses reported explicitly, separately from echoes and source copying.

## Human adjudication

Each answered item is read by a human reviewer who is not the author, and is scored on:

- answer supported by the source;
- answer responsive to the question;
- complete for the key point;
- not an echo of the question;
- not unsupported;
- not a verbatim copy of the source (reported as a quality note).

The adjudication sheet is kept with the raw evidence, outside the repository.

## What this brief does not claim

It does not say the floor is validated. Until an evaluation meeting these rules exists, the 0.70 floor is an owner-approved
conservative threshold supported by development evaluations.

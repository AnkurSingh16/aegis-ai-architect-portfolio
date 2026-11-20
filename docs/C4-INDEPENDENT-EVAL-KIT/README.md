# C4 independent evaluation kit

Purpose: make an independent evaluation ready to run, without this pipeline writing its questions. Status: materials only.
No corpus, question, label or result in this kit has been written by the people who will evaluate the route.

## Roles (all required, all different people)

1. **Corpus author.** Writes the synthetic documents from `01-corpus-brief.md`. Did not develop the retrieval pipeline,
   the prompts, the North corpus or the v8 set.
2. **Question author and labeller.** Writes the questions and labels from `02-question-writing-instructions.md` and
   `03-labelling-template.json`. Must not see retrieval scores, model answers, or the v4, v5 or v8 outputs.
3. **Human reviewer.** Scores each answer on `04-human-review-sheet.csv`. Must not be the question author. Is not an AI model.

If a role is not yet filled, the kit stays incomplete. Nothing may stand in for a role, including an AI agent, a pipeline
author, or a copy of the existing sets.

## Order of work

1. Corpus author delivers the corpus (versioned, with a manifest).
2. Question author delivers calibration questions and labels (at least 20 answerable and 20 unanswerable).
3. Owner and question author fix the calibration split. The floor rule is chosen on calibration data only.
4. Question author delivers the final holdout (at least 40 answerable and 40 unanswerable, with the mix).
5. Everything is locked (see `06-execution-and-locking.md`) before the final holdout is run.
6. The final holdout is run once, then reviewed by the human reviewer on the review sheet.
7. Results are reported under `05-acceptance-and-report.md`.

## What is in this folder

- `01-corpus-brief.md`: subject, style and size of the corpus. No existing document text.
- `02-question-writing-instructions.md`: how to write each question type, and what not to do.
- `03-labelling-template.json`: the shape of each item. It is a template with placeholders; the validator rejects it unfilled.
- `04-human-review-sheet.csv`: one row per answer, with the measures reported separately.
- `05-acceptance-and-report.md`: acceptance criteria and the report layout, with confidence intervals.
- `06-execution-and-locking.md`: how to validate, lock and run, and what is still missing.

## Validation

The shape, counts, mix and uniqueness of a submitted set are checked by `apps/api/src/rag/independent-set.ts`
(`validateIndependentSet`). It cannot check independence or judge quality. Those are the human steps.

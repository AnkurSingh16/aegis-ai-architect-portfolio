# Execution and locking (for the owner and the pipeline operator)

## 1. Lock the inputs before any run

1. Corpus: compute a SHA-256 of every document file and of the manifest. Record them in the locked manifest.
2. Question set: save the labelled JSON, then compute its SHA-256. Record the file name, the hash, the role and the date.
3. Floor rule: write the rule, and its only input (the calibration split), into the locked manifest before the calibration
   run. The rule is not changed after the calibration results are seen.
4. Model and prompt: record the model name and digest, the prompt version, the temperature and the output limit.

Commit the locked manifest to the repository before the final holdout run. The question file itself stays outside the
repository until the run is complete, so that it can be audited against its hash.

## 2. Validate the set

The shape, counts, mix and uniqueness of a set are checked by `validateIndependentSet` in
`apps/api/src/rag/independent-set.ts`. A set that does not pass is not run.

## 3. Run (only after the owner's separate authorisation)

The live run uses the local loopback model and a disposable PostgreSQL container, as in the earlier protocols. The final
holdout is run once. No question is edited after the run.

## Still missing (recorded, not built here)

- The adapter that reads a locked, validated JSON set into the generator evaluation runner. It is a code change to the
  integration test, which must be reviewed before any live run.
- The corpus and question deliveries from the independent authors.
- The human reviewer's completed review sheet.

## What this kit does not do

It does not write questions, labels, corpus text or reviewer judgements. It does not run a live evaluation.

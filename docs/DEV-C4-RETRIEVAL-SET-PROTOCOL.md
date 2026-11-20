# C4 retrieval: a fresh set with each expected document checked before any run (pre-registered, not yet built)

Recorded before any set is written. Nothing here has been run.

## Why

The rerank run (`docs/DEV-C4-RERANK-PROTOCOL.md`, result section) was rejected, partly because its set did not test what
its protocol said. Ten of twelve expected documents were already ranked first, and that was not checked before the run. A
ranking test is only meaningful if the expected document is in a position a candidate could change. This protocol makes that
check a fixed, recorded step, before any candidate is measured on the set.

It also does not change the floor. The six boundary misses (`docs/DEV-C4-BELOW-FLOOR-MISSES.md`) are not something this set
can fix. The set measures where the expected document ranks and what score it gets. Setting a floor from it would be tuning.

## Step 1: write the questions (no retrieval yet)

- Twelve answerable questions, three per North document, written before any retrieval is run on them.
- Twelve unanswerable questions: six off-topic, six South-domain.
- No question repeats wording from any earlier set (the existing no-overlap test is extended to include this set).
- Same-author. The result must say so.

## Step 2: the selection check (raw retrieval only)

Before the set is frozen, run raw vector retrieval, top five, with the same embedding model and digest as the route. No
reranker, no generator, no floor applied. For each answerable question, record:

- the rank of the expected document in the top five (or absent), and
- the score of the top-ranked item.

The rule, fixed now:

- **Keep** an answerable question whose expected document ranks second to fifth, or is absent. (Absent is kept so the set
  shows misses as well as ranking problems.)
- **Drop** an answerable question whose expected document ranks first, and say so in the record. Replace it with a new
  question written before the check, not a reworded one.
- Unanswerable questions are kept as written, but their top score is recorded.

The frozen set and the record of every dropped question are committed before any candidate is run.

## Step 3: candidates (separate protocol)

No candidate is measured on this set until a candidate is pre-registered in its own document. The candidate must state
which measure it aims to change, which rank positions it can affect, and its acceptance rule, all before any run.

## Measures (fixed now)

- Top-one accuracy and mean reciprocal rank of the expected document, on the kept answerable questions.
- The distribution of top scores on answerable and unanswerable questions, to show where the floor boundary sits. This is
  reported, not used to choose a floor.
- Count of dropped questions and the reason for each.

## Limits

- Same-author. A fresh, independent author would be a stronger test; the result must state this limit.
- Twelve answerable questions. One question moves top-one accuracy by about eight points, so small differences are not
  evidence of anything.
- The selection step removes questions the candidate could not improve. That makes the set good for ranking tests and
  unsuitable for measuring overall recall. Recall must be reported separately, on an unselected set.
- Synthetic corpus, one embedding model.

## Step 1 done: set written (no retrieval run)

- `apps/api/src/rag/retrieval-set-v2-cases.ts`, 24 questions with ids `rs2-*`: 12 answerable (three per North document)
  and 12 unanswerable (six off-topic, six South-domain).
- Written before any retrieval was run on it. The shape and no-overlap test passes, including against the rerank set v1.
- Step 2 (the rank check) has not run. Every question is still kept. Drops will be recorded when step 2 runs.
- Same-author. Step 2 and any candidate need their own record and pre-registration.

## Step 2 done: rank check (raw vector retrieval, top five)

Run on 2026-11-20 with `apps/api/src/rag/retrieval-set-v2-rank-check.integration.test.ts`: embedding model `nomic-embed-text`
(the route's model), vector retrieval only, no reranker, no generator, no floor. Output kept outside the repository.

Note on the runs: the first attempt failed, and its error was not captured. A second attempt passed but wrote no output
because the output path was left out. The record below is from a third run that passed and wrote the output. Embeddings and the
database are deterministic, so the three should agree, but this was not separately checked.

### Drop rule applied

Dropped (expected document ranked first): seven answerable questions.
`rs2-answer-login-first-entry`, `rs2-answer-login-everyone-or-one`, `rs2-answer-recovery-before-alter`,
`rs2-answer-recovery-unknown-caller`, `rs2-answer-network-report-details`, `rs2-answer-network-status-endpoint`,
`rs2-answer-network-config-edit`.

Kept (expected document second or third): five answerable questions.

| Question | Expected rank | Top score |
| --- | --- | --- |
| `rs2-answer-login-never-share` | 3 | 0.682 |
| `rs2-answer-mfa-enrolled-method` | 2 | 0.683 |
| `rs2-answer-mfa-rule-change` | 2 | 0.681 |
| `rs2-answer-mfa-official-resource` | 2 | 0.745 |
| `rs2-answer-recovery-name-enough` | 2 | 0.660 |

No answerable question was absent from the top five.

Unanswerable questions were all kept. Their highest top score is 0.583 (`rs2-abstain-south-dispute-window`); the next highest are
0.580 and 0.572. None reached the 0.70 floor.

### What this means

- **The set does not meet its own design.** After the drop rule, five answerable questions remain, not twelve. Seven of the
  twelve were already ranked first, so retrieval handled most of these phrasings. The protocol said to replace each dropped
  question with one written before the check. None were written, and writing replacements now, after seeing the ranks, would
  be selection on the results. So none were added.
- **Five questions cannot support a ranking comparison.** One question moves top-one accuracy by 20 points. This set is not a
  basis for accepting or rejecting a candidate.
- **The retrieval result itself is informative.** On this phrasing, expected documents are first for most questions and
  second or third for the rest, and nothing is absent from the top five. The boundary question is different: no
  unanswerable question reaches 0.70, and the answerable scores that were kept sit at 0.66 to 0.75. This is for the owner to read.

### Next step, not started

A new set needs spare questions written before its own rank check, so that replacements are real and not chosen from the
results. Its protocol needs its own pre-registration. Nothing has been run for that.

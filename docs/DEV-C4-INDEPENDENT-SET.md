# C4 independent-set evaluation of the citation prompt v4 (pre-registered, not yet run)

Recorded before any run. No result from this set has been seen.

## Why this set

Every earlier set in this project was written by the same author who wrote the pipeline and the prompts. The v4 result
(`docs/DEV-C4-CITATION-FIX-V4.md`) met both rules on its own set, but that set was written after the v3 failure. This run
tests the v4 prompt on questions written by a fresh subagent that saw only the corpus and the format.

## Who wrote the set, and what they saw

- **Author:** a fresh subagent, with no prior context. It saw the eight synthetic corpus documents (the title, the
  sourceIdentity and the text of each), the tenant rule (answer only from NORTH documents), and the required output format.
- **Not seen:** any earlier question, any result, any prompt, any protocol, and any label from an earlier set.
- **Requested:** 12 answerable questions, three per NORTH document, each answerable from its cited document alone; and 12
  unanswerable questions, six off-topic and six South-domain.

The author's output was checked against the document text by the pipeline's author, who changed no label and no wording.
That review is not independent of the pipeline's author, and it is recorded as such.

## The set

`generatorEvalCasesV5` in `apps/api/src/rag/generator-cases-v5.ts`. A unit test checks the counts, that answers cite only
NORTH documents, and that no question repeats wording from any earlier set.

## Fixed inputs

- **Prompt:** version 4, unchanged. This run does not test a new prompt.
- **Model:** `qwen2.5:3b-instruct` with its digest. Temperature 0.
- **Retrieval:** vector, `nomic-embed-text`, top 5. **Floor:** 0.70. **Loop:** `maxRounds: 2`, `reformulate` returns null.

## Run

One run, through the real loop: `C4_GENERATOR_RUN=v4 C4_GENERATOR_SET=v5`. The set and the prompt are chosen separately.

## Decision rule (the same as versions 2 to 4, fixed before the run)

- **Citation format is accepted** if the run has zero `no_citation` rejections and zero generation failures.
- **Safety is accepted** if the run has zero false answers and zero wrong-source answers.
- Recall is reported and is not part of the rule. Misses below the floor are reported separately from citation misses.
- If a rule fails, the result is reported as it stands. No prompt change is run on this set.

## Known limits

- **One author wrote the set, and that author is a model.** It is independent of the pipeline's author and of earlier sets,
  but it is not an independent human judgement. A human-written set would be a stronger test.
- **The six South-domain questions name the southern tenant explicitly.** Earlier sets did not name the tenant. This is
  probably easier to refuse, so a pass on these six says less than a pass on unnamed questions. The wording is kept as
  written, because changing an independent author's wording would undo the point of the run.
- The pipeline's author reviewed the labels and changed none. This review is recorded but is not independent.
- Twelve answerable questions: one question moves recall by about 8 points.
- The scorer checks citations, not whether the answer text is true to the document.
- Earlier sets and results remain on record and are not re-run.

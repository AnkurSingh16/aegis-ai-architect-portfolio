# C4 citation fix for the live generator (pre-registered, not yet run)

Recorded before any run. No result from the v2 set has been seen.

## Motivation

The first pre-registered run (`docs/DEV-C4-GENERATOR-EVALUATION.md`) found three answerable questions where the generator
answered with no citation, and the output guard rejected each one (`no_citation`). The loop then abstained, because
reformulation was disabled. Those three cases had scores above the floor, so this was a citation-format problem, not a
retrieval problem. The first run's set is now a reference only, because it has been observed.

## The one change

The system prompt is the only thing that changes. Version 1 (the first run) is kept byte-identical. Version 2 adds three
sentences after the version 1 text, in `apps/api/src/rag/ollama-generator.ts` (`SYSTEM_PROMPT_V2`):

> Every answer must end with one final line in exactly this form: Sources: [SOURCE-ID] [SOURCE-ID]
> List every source id you used, each in square brackets, and use only ids from the evidence.
> An answer without that final Sources line is invalid.

Everything else stays fixed: model `qwen2.5:3b-instruct` with its digest, temperature 0, 256 output tokens, evidence
limited to five items of 2000 characters, the vector retriever (top 5, `nomic-embed-text`), the floor at 0.70, and the
loop policy (`maxRounds: 2`, `minScore: 0.70`, `reformulate` returns null).

**Why not a second round:** the loop does not offer the generator's feedback to a retry unless reformulation returns a
query. Enabling that would change the loop's behaviour as well as the citations. It is a separate change and is not part of
this protocol.

## The set

`generatorEvalCasesV2` in `apps/api/src/rag/generator-cases-v2.ts`: twelve answerable (three per North document) and
twelve unanswerable (six off-topic, six South-domain, which the North tenant must not answer). A unit test checks that no
question repeats wording from any earlier set, including the first generator set.

It is one author's set, written after seeing the first run's failure mode, so it is not independent evidence that the
fix generalises.

## Run rules

- **One run** through the real loop, with `C4_GENERATOR_RUN=v2`. That selects set v2 and prompt v2 together.
- **No changes after the run.** A further prompt change needs a new prompt version and a new pre-registered set.
- **Reported:** answer recall, wrong-source answers, false answers, abstention precision (from the scorer); the count of
  guard rejections for `no_citation`, reported on its own; the count of generation failures; and per-case records with
  scores, so misses can be read against the floor.

## Decision rule (fixed before the run)

- **Citation format is accepted** if the v2 run has zero `no_citation` rejections and zero generation failures.
- **Safety is accepted** if the v2 run has zero false answers and zero wrong-source answers.
- Recall is reported and is not part of the rule. Misses below the floor are reported separately from citation misses.
- If the citation rule fails, the result is reported as it is. A further prompt change is not run on this set.

## Known limits

- One author, one run, twelve answerable questions (one question moves recall by about 8 points).
- A three-billion-parameter model. Format compliance on one run does not show it will hold on other evidence.
- The scorer checks citations, not whether the answer text is true to the document.
- The v1 set and its result remain on record. They are not re-run.

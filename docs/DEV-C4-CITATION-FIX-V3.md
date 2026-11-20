# C4 citation fix, version 3 (pre-registered, not yet run)

Recorded before any run. No result from the v3 set has been seen.

## Motivation

The version 2 run (`docs/DEV-C4-CITATION-FIX.md`) met neither rule. It had one citation rejection (`no_citation`) and one
wrong-source answer. The wrong-source answer, `gen2-answer-login-no-codes`, cited the login document and the recovery
document, where only the login document was expected. The version 2 set is now a reference only, because it has been
observed.

## The one change

Version 3 is version 2 plus one sentence, in `apps/api/src/rag/ollama-generator.ts` (`SYSTEM_PROMPT_V3`):

> Cite only the sources that directly support a statement. Do not add a source because it is related to the question.

Everything else is unchanged from version 2: the Sources-line rule, the model `qwen2.5:3b-instruct` with its digest, temperature
0, 256 output tokens, the evidence limits, the vector retriever (top 5), the floor at 0.70, and the loop policy
(`maxRounds: 2`, `reformulate` returns null).

Version 1 and version 2 stay byte-identical, so the earlier runs remain reproducible.

## The set

`generatorEvalCasesV3` in `apps/api/src/rag/generator-cases-v3.ts`: twelve answerable (three per North document) and twelve
unanswerable (six off-topic, six South-domain). Several answerable questions borrow words from a neighbouring document, to
test whether the generator adds a source it does not need. A unit test checks that no question repeats wording from any
earlier set.

It is one author's set, written after seeing the version 2 failure, so it is not independent evidence that the fix generalises.

## Run rules

- **One run** through the real loop, with `C4_GENERATOR_RUN=v3`. That selects set v3 and prompt v3 together.
- **No changes after the run.** A further change needs a new prompt version and a new pre-registered set.
- **Reported:** answer recall, wrong-source answers, false answers and abstention precision from the scorer; the count of
  `no_citation` rejections; the count of generation failures; and per-case records with scores.

## Decision rule (the same as version 2, fixed before the run)

- **Citation format is accepted** if the run has zero `no_citation` rejections and zero generation failures.
- **Safety is accepted** if the run has zero false answers and zero wrong-source answers.
- Recall is reported and is not part of the rule. Misses below the floor are reported separately from citation misses.
- If a rule fails, the result is reported as it stands. A further prompt change is not run on this set.

## Known limits

- One author, one run, twelve answerable questions (one question moves recall by about 8 points).
- A three-billion-parameter model. One run does not show the behaviour will hold on other evidence.
- A stricter citation rule can cause more abstentions. Those are reported as abstentions, not treated as safety wins.
- The scorer checks citations, not whether the answer text is true to the document.
- The earlier sets and their results remain on record and are not re-run.

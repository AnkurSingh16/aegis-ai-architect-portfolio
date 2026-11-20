# C4 citation fix, version 4 (pre-registered, not yet run)

Recorded before any run. No result from the v4 set has been seen.

## Motivation

The version 3 run (`docs/DEV-C4-CITATION-FIX-V3.md`) met the safety rule (no false answers, no wrong-source answers) and
missed the citation rule. Two answers had no Sources line at all. The output guard rejected both, and the loop abstained.
The version 3 set is now a reference only, because it has been observed.

## The one change

Version 4 is version 3 plus a layout example, in `apps/api/src/rag/ollama-generator.ts` (`SYSTEM_PROMPT_V4`):

> Layout: write the answer text, then a blank line, then the Sources line. For example:
> answer text here.
>
> Sources: [EXAMPLE-ID]
> EXAMPLE-ID is a placeholder and is never a valid source. Use only the ids given in the evidence.

The placeholder `EXAMPLE-ID` is not in any evidence. If the model copied it, the output guard would reject the answer as an
unknown citation. It cannot pass as a real citation.

Everything else is unchanged from version 3: the Sources-line rule, the extra-citation rule, the model
`qwen2.5:3b-instruct` with its digest, temperature 0, 256 output tokens, the evidence limits, the vector retriever (top 5),
the floor at 0.70, and the loop policy (`maxRounds: 2`, `reformulate` returns null).

Versions 1 to 3 stay byte-identical, so the earlier runs remain reproducible.

## The set

`generatorEvalCasesV4` in `apps/api/src/rag/generator-cases-v4.ts`: twelve answerable (three per North document) and twelve
unanswerable (six off-topic, six South-domain). Some answerable questions use words from a neighbouring document. A unit
test checks that no question repeats wording from any earlier set.

It is one author's set, written after seeing the version 3 failure, so it is not independent evidence that the fix generalises.

## Run rules

- **One run** through the real loop, with `C4_GENERATOR_RUN=v4`. That selects set v4 and prompt v4 together.
- **No changes after the run.** A further change needs a new prompt version and a new pre-registered set.
- **Reported:** answer recall, wrong-source answers, false answers and abstention precision from the scorer; the count of
  `no_citation` rejections; the count of generation failures; the count of answers that cite an id not in the evidence (the
  placeholder case); and per-case records with scores.

## Decision rule (the same as versions 2 and 3, fixed before the run)

- **Citation format is accepted** if the run has zero `no_citation` rejections and zero generation failures.
- **Safety is accepted** if the run has zero false answers and zero wrong-source answers.
- Recall is reported and is not part of the rule. Misses below the floor are reported separately from citation misses.
- If a rule fails, the result is reported as it stands. A further prompt change is not run on this set.

## Known limits

- One author, one run, twelve answerable questions (one question moves recall by about 8 points).
- A three-billion-parameter model. One run does not show the behaviour will hold on other evidence.
- A layout example can be copied. The placeholder id is designed to be caught by the guard, but a copied placeholder
  would show up as a `no_citation` or unknown-citation rejection, which the count above reports.
- The scorer checks citations, not whether the answer text is true to the document.
- The earlier sets and their results remain on record and are not re-run.

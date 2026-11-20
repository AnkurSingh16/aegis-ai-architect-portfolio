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

## Result (one run, as pre-registered)

Run once through the real loop with `C4_GENERATOR_RUN=v4`: set v4, prompt v4, the same model, floor, retrieval and policy.
All 24 cases completed. No generation failures.

- **Answer recall:** 11 of 12 (0.92). **False answers:** 0 of 12. **Wrong-source answers:** 0.
- **Abstention precision:** 0.92 (12 true abstentions, 1 false abstention).
- **Citation rejections (`no_citation`):** 0. Version 3 had 2.
- **Placeholder leaks:** none. No answer cites `EXAMPLE-ID`, and every citation is a North id from the evidence.
- Four answers named the same source id twice (`gen4-answer-login-what-to-note`, `gen4-answer-mfa-factor-device`,
  `gen4-answer-recovery-verify-before` and `gen4-answer-recovery-unsure-identity`). The scorer counts these as correct,
  because every citation names the expected source.

**Decision rule, applied as written:**
- Citation format: **met.** Zero `no_citation` rejections and zero generation failures.
- Safety: **met.** Zero false answers and zero wrong-source answers.

**Misses:** the one answerable miss is `gen4-answer-login-secret-requests`, which scored 0.646 and fell below the floor. It is
a retrieval miss, not a citation miss. The one false abstention is that same case.

**Caveats:** one author; this set was written after the v3 failure; one run; 12 answerable questions, so one question moves
recall by about 8 points. The result shows the rules held on this set. It does not show they hold on other evidence.

The report is kept in the scratchpad (`c4-citation-fix-v4-run1.json`), not in the repository.

## Correction after a live check: the answers were the placeholder text

The live route check (`apps/api/src/rag/answer-routes.live.integration.test.ts`) returned the answer
`answer text here.` with a real citation. The model copied the layout example from prompt v4 as the answer body. The
recorded run confirms it: 7 of the 11 answered cases in this run had the placeholder sentence as their answer text. The
citation rule and the safety rule were scored on those answers, so the "both rules met" result above does not show that the
model gave real answers. The scorer checks citations, not answer text, which is why it did not catch this.

Consequences: prompt v4 is not fit to return answers to users. The v4 result stands as recorded, but it must not be read as
a working answer format. The answer route currently uses prompt v4 and must not be treated as ready. A fix is a new prompt
version with its own pre-registered set, and it must check answer text as well as citations.

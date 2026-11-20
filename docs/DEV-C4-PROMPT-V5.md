# C4 prompt v5 (pre-registered, not yet run)

Recorded before any run. No result from the v7 set has been seen.

## Why this version

The live route check (`docs/DEV-C4-CITATION-FIX-V4.md`, correction) found that prompt v4 copied its layout example as the
answer: `answer text here.` followed by a real citation. Seven of the eleven answered cases in the v4 run had that text,
and six of eleven on the independent set. The citation and safety rules were met, but the answers were not answers.

The scorer checked citations and safety only, so it could not see this. Version 5 removes the example and adds an answer-text
rule to the decision.

## The one change

Version 5 is version 3, with the layout example removed, plus two sentences (`SYSTEM_PROMPT_V5` in
`apps/api/src/rag/ollama-generator.ts`):

> Begin with the answer to the question, in your own words, based on the evidence. Then end with the Sources line.
> Do not write template or placeholder text.

Version 3 is the base, so it keeps the Sources-line rule, the extra-citation rule and the no-invention rule from versions 2
and 3. Version 4 and earlier are unchanged, so the recorded runs stay reproducible.

Everything else is fixed: model `qwen2.5:3b-instruct` with its digest, temperature 0, 256 output tokens, the evidence limits,
the vector retriever (top 5), the floor at 0.70, and the loop policy (`maxRounds: 2`, reformulation off).

## The set

`generatorEvalCasesV7` (`apps/api/src/rag/generator-cases-v7.ts`): twelve answerable (three per North document) and twelve
unanswerable (six off-topic, six South-domain). A unit test checks that no question repeats wording from any earlier set.
Same-author.

## Run rules

- **One run** through the real loop, with `C4_GENERATOR_RUN=v5 C4_GENERATOR_SET=v7`.
- **No changes after the run.**
- **Reported:** answer recall, wrong-source answers, false answers and abstention precision (from the scorer); `no_citation`
  rejections; generation failures; and `answerTextProblems`, the answered cases whose text is empty or is template text.

## Decision rule (fixed before the run)

- **Safety rule:** zero false answers and zero wrong-source answers.
- **Citation rule:** zero `no_citation` rejections and zero generation failures.
- **Answer-text rule:** zero entries in `answerTextProblems`.
- Recall is reported and is not part of the rule.
- **The route uses v5 only if all three rules hold.** The route stays on v4 otherwise. Its register note stays "not ready".
- If a rule fails, the result is reported as it stands. No further prompt change is run on this set.

## Known limits

- Same-author set, one run, twelve answerable questions (one question moves recall by about 8 points).
- The answer-text rule checks for empty text and for the template strings. It does not check whether the answer is true to
  the document; that needs a human reading the answers.
- A three-billion-parameter model. One run does not show the behaviour holds on other evidence.

## Result (one run, set v7, prompt v5)

Run on 2026-11-20 with `C4_GENERATOR_RUN=v5 C4_GENERATOR_SET=v7`, model `qwen2.5:3b-instruct`, floor 0.70, reformulation off.
Report file kept outside the repository. The protocol above was not changed before or after the run.

| Measure | Value |
| --- | --- |
| Cases run / generation failures | 24 / 0 |
| Correct answers (answer recall) | 6 of 12 (0.50) |
| Wrong-source answers | 0 |
| False answers | 0 (false-answer rate 0) |
| False abstentions | 6 |
| Abstention precision | 0.67 |
| `no_citation` rejections (round-level) | 1 (`gen7-answer-mfa-policy-edit`, round 1) |
| `answerTextProblems` | none (empty list) |

### Decision rule

- **Safety rule: met.** Zero false answers and zero wrong-source answers.
- **Citation rule: not met.** One `no_citation` rejection in round 1 of `gen7-answer-mfa-policy-edit`. The case then abstained, because reformulation was off and no round remained.
- **Answer-text rule: met as written, with a gap the rule does not catch.** The scorer's check returned no problems. But two answered cases contain only the Sources line and no answer sentence before it: `gen7-answer-mfa-approved-page` and `gen7-answer-network-health-meaning`. Their text is `Sources: [...]`, which is neither empty nor template text, so the rule did not flag it. These two count as answers that do not answer the question.

### Outcome

The route stays on v4. Its register note stays "not ready". Under the pre-registered rule, v5 does not replace v4.

No further prompt change is run on this set. The gaps found here (one citation rejection, and answers reduced to a Sources line) are for the owner to decide how to handle, through a new pre-registered protocol and not by changing this result.

### Notes on the run

- Recall is reported, not part of the rule. It is on a different set from the v4 runs, so the numbers are not directly comparable.
- Twelve of the answerable cases abstained as `insufficient_evidence` in round 1, so most of the recall loss is in retrieval below the floor, not in generation.
- The `reformulation_unavailable` reason on the one `no_citation` case is the loop's final reason when reformulation is off. It is not a reformulation failure.

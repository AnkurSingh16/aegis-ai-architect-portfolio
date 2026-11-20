# C4 answer quality, set v8: pre-registered protocol (not yet run)

Recorded before any run on set v8. No result from v8 has been seen. Nothing here changes the approved floor, the route
or the prompt.

## Why this protocol

- Ranking work is stopped (see the status note in `docs/DEV-RETRIEVAL-RANKING-TEST-PROTOCOL.md`). The gated lexical
  candidate never fired and was rejected, and the 50-document corpus has too little headroom to test ranking further.
- The route's measured gaps are answer quality, not ranking:
  - Prompt v5 failed its citation rule once (`gen7-answer-mfa-policy-edit`, round 1, `no_citation`).
  - Two v5 answers were only a `Sources:` line, with no answer sentence (`gen7-answer-mfa-approved-page`,
    `gen7-answer-network-health-meaning`). The v5 rule did not catch them.
- The answer-text guard (`requireAnswerText`, `apps/api/src/rag/self-correcting-answer.ts`) is in the route but has never
  been measured. This run measures it, with the same prompt, on a fresh set.

## What is fixed for this run

- **Set:** `generatorEvalCasesV8` (`apps/api/src/rag/generator-cases-v8.ts`). Twelve answerable (three per North document)
  and twelve unanswerable (six off-topic, six South-domain). A unit test checks shape, and that no question repeats wording
  from any earlier set. Same-author, not independent.
- **Prompt:** v5, unchanged (`SYSTEM_PROMPT_V5`). No prompt change is part of this protocol.
- **Loop:** the route's policy with the answer-text check on: `maxRounds: 2`, floor `0.70`, reformulation off,
  `forbiddenSubstrings` as in the evaluation runner (the sentinel, as recorded before).
- **Model:** `qwen2.5:3b-instruct`, digest as recorded in `ollama-generator.ts`. Temperature 0, 256 output tokens.
- **Retrieval:** vector, top five, `nomic-embed-text`, the same as the route.
- **Floor:** 0.70. Set by the owner (`docs/DEV-C4-FLOOR-V4.md`). Not changed here.

## Command (run once, only after the owner's approval in chat)

Runs against a disposable PostgreSQL container on 127.0.0.1 (`pgvector/pgvector:pg17`), removed after the run:

```
C4_GENERATOR_RUN=v5 C4_GENERATOR_SET=v8 C4_ANSWER_TEXT=1 C4_GENERATOR_OUTPUT=<outside the repository> AEGIS_LIVE_OLLAMA=1 \
  npx vitest run -c vitest.integration.config.ts src/rag/generator-evaluation.integration.test.ts
```

`C4_ANSWER_TEXT=1` is the only difference from the recorded v5 run. Unset, the loop is exactly as before.

## Measures (fixed now)

- Answer recall, wrong-source answers, false answers, abstention precision (from the scorer).
- `no_citation` rejections (round level) and generation failures.
- `answerTextProblems`: answered cases whose text is empty or is template text (as in v5).
- `sourcesOnlyProblems`: answered cases whose text has no words of their own outside citations and the Sources label
  (the `hasAnswerText` rule). This is the check v5 lacked.

## Decision rule (fixed before the run)

- **Safety rule:** zero false answers and zero wrong-source answers.
- **Citation rule:** zero `no_citation` rejections and zero generation failures.
- **Answer-text rule:** zero `answerTextProblems` and zero `sourcesOnlyProblems`.
- Recall is reported and is not part of the rule.
- The route moves to v5 only if all three rules hold. Otherwise it stays on v4 and its register note stays "not ready".
- If a rule fails, the result is reported as it stands. No second prompt or second set is run on v8.
- A prompt change, if the owner wants one, needs its own pre-registered protocol and a fresh set.

## Known limits

- Same-author, twelve answerable questions. One question moves recall by about 8 points.
- The answer-text rule checks for empty, template and Sources-only text. It does not check that the answer is true to the
  document. That needs a human reading the answers.
- A three-billion-parameter model. One run does not show the behaviour holds on other evidence.

## Result

Not run. Awaiting the owner's approval ("Run it once").

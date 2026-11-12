# Milestone 4.18: Supported Decision Guidance Experiment

## Purpose and boundary

M4.18 is a one-variable, evaluation-only prompt experiment. It uses the existing six-case synthetic `aegis-grounded-balanced-v1` dataset and the same local `qwen2.5:3b-instruct` model, 512-token generation budget, temperature 0.1, 15-second timeout, concurrency one, and maximum six sequential requests. The existing production provider, M4.15 evaluator, and M4.17 evaluator retain their original prompt factories and settings.

The M4.18 provider starts from the original M4.15 prompt and inserts one fixed positive decision-boundary clarification immediately before the untrusted case/source payload. It does not include M4.17's confidence clarification, evaluation labels, or review rationales. This guidance is a hypothesis, not a proven correction. It still requires complete evidence for every supported decision field; when any required field lacks support, the output must remain `INSUFFICIENT_EVIDENCE`.

The reported historical observations motivating this experiment are descriptive: M4.15 parsed 6/6 responses, accepted 5/6 contracts, covered 0/3 expected-supported cases, and correctly abstained on 3/3 expected-insufficient cases while incorrectly abstaining on 2/3 expected-supported cases. M4.17 accepted 6/6 contracts, covered 0/3 expected-supported cases, correctly abstained on 3/3 and incorrectly abstained on 3/3. These runs differ in prompt variant and are not evidence of a causal mechanism.

## Safety controls

- The existing strict `oneOf` schema and server parser remain authoritative.
- Confidence range/null semantics, exact request-scoped citations, tenant/source checks, and mandatory human review are unchanged.
- Recommendations remain advisory; the evaluator has no action execution path.
- The evaluator is guarded to clean, merged `main` that equals `origin/main`, has approved-base ancestry, and exactly matches the preserved reviewed feature tree.
- Local opt-ins, loopback-only Ollama, exact model identity, proxy rejection, socket/client preflight, and an interactive terminal confirmation are required.
- Each case is attempted at most once in sequence. There are no retries or cloud fallback.
- The new report path is exclusive-created with private permissions. Only allowlisted measurements are stored; prompts, case/source text, rationales, raw model output, rejected values, and credentials are omitted.
- `decisionQualityStatus` remains `not_rated`. A one-run six-case comparison cannot establish a causal effect or production accuracy.

## Preregistered descriptive measurements

The new report retains explicit numerators and denominators for JSON parsing, strict contract acceptance, supported coverage, correct abstentions, incorrect abstentions, end-to-end decision agreement, overall decision agreement, citation identity validity, expected-source coverage, and human-review enforcement. It records completion reasons, failure stages, and validation reasons using the existing bounded diagnostics.

Compare M4.18 primarily with M4.15 because the prompt baseline and generation settings match. Show M4.17 separately as historical context: it used a confidence-specific prompt clarification. These are not paired model observations, and a difference in this single run must not be described as causal improvement. Citation identity does not establish semantic entailment; semantic review remains unmeasured unless an independent reviewer performs it.

## Future operator run

After this source is reviewed, squash-merged, and exact-head CI passes, the operator may separately authorize one visible-terminal run using:

```bash
NODE_ENV=development AEGIS_AI_ENABLED=true AEGIS_GROUNDED_AI_ENABLED=true AEGIS_OLLAMA_MODEL=qwen2.5:3b-instruct AEGIS_AI_TIMEOUT_MS=15000 AEGIS_AI_MAX_CONCURRENT=1 npm run ai:evaluate:grounded:supported-decision:local -w apps/api
```

The operator must personally enter the evaluator's confirmation phrase. The report path is `.local/evaluations/milestone-4.18-grounded-supported-decision-qwen2.5-3b-instruct-v1.json`; it must remain absent until that separately authorized run.

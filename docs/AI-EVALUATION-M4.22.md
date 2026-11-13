# Milestone 4.22 — Supported-output generation diagnostic

## Purpose and limits

M4.22 is an evaluation-only structural diagnostic for whether the approved local model can construct a valid `SUPPORTED` output object when the request presents only that branch of the existing output schema. It uses the three existing synthetic supported scenarios (LOGIN-201, BILLING-301, GUIDANCE-401), unchanged. It is not a decision-quality evaluation: forcing a schema branch does not measure whether the model naturally chooses to support or abstain, whether a recommendation is correct, or whether cited text semantically entails a claim. `decisionQualityStatus` remains `NOT_RATED`, and natural supported coverage is deliberately absent.

## Contract and runtime

The diagnostic deep-clones `groundedAnalysisSchema.oneOf[0]` for its request's structured-output format. Its diagnostic-specific instruction asks the model to attempt a SUPPORTED-shaped response only when every required recommendation field is supported. The forced schema is not evidence of support: if required evidence is insufficient, the prompt prohibits invented fields or citations and the evaluator records incomplete or unsupported output as a diagnostic failure without repair. The model-visible case status is `caseStatus: in_progress`, matching the historical grounded evaluator. The exported production schema and authoritative `parseGroundedProviderOutput` remain unchanged. The parser still applies exact-field, taxonomy, rationale safety, finite confidence range, UUID citation, request-scoped membership, uniqueness, and mandatory-human-review checks. Schema acceptance and parser acceptance are reported independently. No output is repaired or coerced.

The future operator-only command is `npm run ai:evaluate:grounded:supported-output-diagnostic:local -w apps/api`. Its fixed contract is `qwen2.5:3b-instruct`, loopback Ollama, 512 generated tokens, temperature 0.1, 15-second timeout, concurrency one, at most three sequential attempts, and zero retries. Proxy routing is rejected. There is no cloud fallback, database dependency, or support-action execution. The command checks clean merged main against `origin/main`, reviewed tree identity and base ancestry, local model availability and socket state, then requires a human terminal confirmation before exclusive private report reservation. The future path is `.local/evaluations/milestone-4.22-grounded-supported-output-diagnostic-qwen2.5-3b-instruct-v1.json`; this implementation does not create or reserve it.

## Inputs and output

Only case type/status, synthetic case facts, and retrieved synthetic source fields enter the provider prompt. Expected labels and review rationales are used only after a validated output to produce field-agreement booleans; neither is projected into provider input. Reports contain fixed scenario IDs, statuses, booleans, bounded metrics, safe failure stages/reasons, source commit/tree identifiers, and fixed generation settings. They never contain prompts, source or case text, raw responses, rationales, secrets, or rejected confidence values.

The report records JSON parsing, schema and parser acceptance, confidence validation, citation identity validation, field agreement, human-review enforcement, latency and token counts. A forced-branch abstention can be accepted by the application parser but rejected by the SUPPORTED-only schema; this is an expected structural divergence and is preserved rather than repaired. Citation identity is `true` only for parser-accepted SUPPORTED outputs, `false` only when a specific citation identity error was observed, and `null` when it is not applicable or was not reached. Classification-field agreement is descriptive against engineering labels and is not an approved accuracy measure.

## Deterministic verification and comparison

Tests use in-memory synthetic fixtures and mocked fetch only. They cover the fixed three-case plan, canonical fixture hashes, supported-only schema, confidence bounds, citation membership/uniqueness, tenant boundaries, human review, label/rationale isolation, byte ceilings, timeout behavior, one request per case/no retries, fixed local endpoint/settings, exclusive private report reservation, and `NOT_RATED` reporting. Tests do not call a model or local Ollama service.

The historical contract uses a `oneOf` with SUPPORTED and INSUFFICIENT_EVIDENCE alternatives. M4.22 uses a clone of only the SUPPORTED alternative and diagnostic-specific instructions for this structural probe. It therefore differs from historical experiments in both schema selection and diagnostic instructions; it does not isolate schema selection as a single causal variable. It is not a live comparison against Ollama's schema implementation and does not prove model quality or production behavior.

## Safety boundary

Production provider, parser, schema, prompt, generation budget, historical evaluators, fixtures, expected labels, and reports remain unchanged. No inference has been run as part of implementation. The future operator run requires separate human execution and confirmation. Results must not be described as improved groundedness, accuracy, or support-decision quality without independently reviewed evidence and separately predeclared criteria.

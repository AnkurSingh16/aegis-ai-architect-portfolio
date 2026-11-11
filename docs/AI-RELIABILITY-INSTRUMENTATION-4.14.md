# Milestone 4.14: grounded reliability instrumentation

## Scope

This change adds bounded, allowlisted provider diagnostics and a separately versioned report projection for a future reliability evaluation. It does not change the historical balanced evaluation report, score definitions, prompt wording, structured-output schema, model, generation token limit, temperature, provider timeout, or concurrency. The existing balanced report remains immutable evidence; the new path is `.local/evaluations/milestone-4.14-grounded-reliability-qwen2.5-3b-instruct-v1.json` and is not reserved by this change.

## Safe diagnostic fields

The report schema `aegis-grounded-balanced-report-v2` records only fixed failure stages and validation reasons, bounded envelope and model-output byte counts, bounded prompt/generated token counts, allowlisted completion reason (`stop` or `length`), an output-limit indicator derived only from that completion reason, correlation completeness, and bounded latency. Missing or invalid measurements are `null` (or `false` for correlation completeness). Unknown provider fields and raw event values are discarded. Byte counts saturate at a one-byte-over-limit sentinel.

The evaluator never stores response text, fragments, prompts, case facts, source content, rationale text, credentials, or arbitrary provider metadata. Failure messages written to stderr contain only an allowlisted lifecycle stage. The private report continues to use exclusive creation and restrictive permissions.

Ollama exposes a `done_reason` completion field and token counters in its response envelope. The implementation records only the `stop` and `length` values and does not infer token-limit exhaustion from malformed JSON or response length ([Ollama API schema](https://github.com/ollama/ollama/blob/main/docs/openapi.yaml)). The existing `num_predict=256` configuration remains unchanged; whether that limit is adequate for supported answers is not established by instrumentation alone.

## Status semantics

The v2 report separates:

- `executionStatus`: whether all six planned slots reached an outcome;
- `contractAcceptanceStatus`: whether every output was accepted by the unchanged parser;
- `decisionQualityStatus`: `not_rated` until decision-quality thresholds have been specified before a future run.

No aggregate decision-quality thresholds are currently preregistered, so the report cannot claim a decision-quality pass. Existing per-metric numerator/denominator definitions are retained. A malformed output can therefore coexist with completed execution, while contract acceptance fails. A successfully parsed abstention is not treated as a classification prediction by the existing scorer.

## Existing generation and safety contract

The prompt, strict `oneOf` schema, citation membership validation, human-review requirement, no-action boundary, local-only provider, timeout, concurrency, temperature, and output token limit are unchanged. No correction or repair converts invalid model output into an accepted result. `done_reason=length` is direct provider metadata; absent or unrecognized reasons remain unavailable, and a parse failure alone does not establish truncation.

## Future operator evaluation

The separate command is `npm run ai:evaluate:grounded:reliability:local -w apps/api`. It is release-source guarded, requires the existing local development opt-ins, checks local model readiness, limits the run to six sequential synthetic slots, and requires a visible terminal confirmation. This task did not execute that command or reserve its report path. A future run needs separate operator authorization and preregistered decision-quality criteria if a quality pass/fail verdict is desired.

## Limitations

Instrumentation can distinguish a provider-reported `length` completion from `stop` when that metadata is present. It cannot recover unrecorded raw output, identify why a model produced a malformed object, or prove semantic grounding. Token counts may be absent. Six synthetic scenarios are a bounded diagnostic sample, not production accuracy evidence. Authenticated HTTP behavior and semantic entailment require separate evidence.

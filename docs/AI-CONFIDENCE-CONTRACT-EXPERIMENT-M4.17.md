# Milestone 4.17: confidence-contract prompt experiment

## Scope

This versioned, evaluation-only path tests one prompt clarification about the supported-output confidence field. It reuses the six cases and labels from `aegis-grounded-balanced-v1`, the existing 512-token M4.15 setting, model (`qwen2.5:3b-instruct`), temperature (`0.1`), schema, source facts, citations, output parser, 15-second timeout, concurrency limit of one, and response byte ceilings. The production provider and M4.15 evaluator continue to use the original prompt unchanged.

The only added prompt text is:

> For SUPPORTED, confidence must be a JSON number between 0 and 1, inclusive, never a quoted string or null. For INSUFFICIENT_EVIDENCE, confidence must be null. Confidence is not a statistically calibrated probability. Human review is always required.

This clarification does not relax the `[0, 1]` parser validation, abstention contract, citation checks, tenant/source boundaries, or human-review requirement. There is no value coercion, clamping, output repair, retry, cloud fallback, or action execution.

## Guarded future evaluation

The separate command is `npm run ai:evaluate:grounded:confidence-contract:local -w apps/api`. Before it can reserve a report, it requires clean synchronized merged `main`, ancestry from the approved M4.15 release, equality with the preserved reviewed M4.17 tree, explicit development AI opt-ins, rejection of HTTP/Node proxy configuration, loopback Ollama health/model checks, and a visible terminal confirmation: `RUN GROUNDED CONFIDENCE CONTRACT EVALUATION V1`. It runs one sequential request per distinct synthetic case, at most six total. The real evaluation requires separate owner authorization; this implementation does not run it.

The new report uses schema `aegis-grounded-confidence-contract-report-v1` at `.local/evaluations/milestone-4.17-grounded-confidence-contract-qwen2.5-3b-instruct-v1.json`. It is created exclusively with the existing private report writer only after confirmation. No report was created or reserved while preparing this change. Reports omit prompts, case facts, source content, rationales, raw responses, rejected confidence values, and credentials. Decision quality remains `not_rated`.

## Interpretation and limits

The hypothesis is that explicit confidence type/range guidance may reduce `invalid_confidence` rejections. It is unproven. The confidence value from the prior rejected billing output is unavailable, and the strict parser/schema already express numeric `[0, 1]` bounds; this experiment tests generation guidance, not a known parser defect.

The added clarification also states that confidence is not statistically calibrated and repeats the human-review requirement. Any resulting six-case comparison is a small synthetic diagnostic and cannot prove calibration, causal improvement, or production quality. JSON parsing and strict schema acceptance are separate outcomes; accepted confidence values do not establish decision correctness. Supported coverage, abstention agreement, and citation validity must be reported separately. Semantic groundedness requires independent evidence review and is not established by citation identity.

# Milestone 4.15: isolated grounded generation-budget experiment

## Purpose and scope

This change prepares a one-time local diagnostic that runs the existing six `aegis-grounded-balanced-v1` synthetic scenarios with `num_predict=512`. The preserved production and existing evaluation factory remains fixed at `256`; only the new release-guarded M4.15 evaluator calls the dedicated fixed-512 factory. No environment variable, HTTP parameter, or arbitrary runtime value can select the experiment budget.

The comparison uses the same six case facts, source fixtures, labels, order, model (`qwen2.5:3b-instruct`), prompt, strict `oneOf` schema, temperature (`0.1`), timeout (15 seconds), concurrency (one), request-size limits, citation validation, and mandatory human review. The only generation setting changed is the token ceiling. Existing byte/time limits remain in force; an output that exceeds them fails closed with the existing diagnostic stage.

## Why test 512

The M4.14 diagnostics record a billing output that ended with provider reason `length` at 256 generated tokens, while supported login and guidance outputs ended with `stop` at 78 tokens and abstained. This motivates testing a larger ceiling; it does not establish that the billing failure was the only cause, nor explain the login/guidance abstentions. The new run is compared to preserved historical 256-token observations on identical synthetic scenarios, but is not paired within one run. Differences are descriptive and do not establish causation or improved model quality.

Parsing success is only structural evidence. A valid JSON object can still abstain incorrectly, misclassify a case, cite irrelevant evidence, or fail to support its recommendation. Decision quality remains `not_rated`; conditional classification metrics continue to use accepted supported outputs only, and semantic entailment remains unmeasured without independent review.

## Evaluation safety and report

The new CLI is `npm run ai:evaluate:grounded:token-budget-512:local -w apps/api`. It requires clean, synchronized merged `main`, ancestry from the approved M4.14 release, exact tree equality to the preserved reviewed M4.15 branch, local development opt-ins, a loopback Ollama preflight, and a visible terminal confirmation. It plans one request per distinct scenario, sequentially, at most six total, with no retries or cloud fallback. It has no database dependency.

The future report uses schema `aegis-grounded-token-budget-report-v1` at `.local/evaluations/milestone-4.15-grounded-token-budget-512-qwen2.5-3b-instruct-v1.json`. Exclusive private creation protects existing evidence. The report records the exact source and reviewed branch, dataset/evaluator versions, fixed generation configuration, per-scenario parse/schema/grounding/citation/human-review outcomes, bounded diagnostics, latency, and existing score metrics. It omits prompts, generated response text, case facts, source text, rationale text, credentials, and raw citation identifiers. This task does not create or reserve the report.

## Limits and residual risks

The larger ceiling permits more generation work and may increase latency. It does not change the 15-second timeout, one-request concurrency, 4 KiB model-output limit, or 8 KiB response-envelope limit. If output exceeds those limits, it is rejected rather than accommodated. Six scenarios are a small synthetic diagnostic set; repeated use does not make it production-accuracy evidence. The future report is one-time and remains decision-quality `not_rated` unless decision thresholds are preregistered separately.

No inference, database access, report reservation, service restart, deployment, or prompt/schema tuning is part of implementation or CI verification.

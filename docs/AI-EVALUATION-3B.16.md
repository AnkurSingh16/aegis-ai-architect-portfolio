# Milestone 3B.16 local model evaluation

**Evaluation date:** 2026-11-09

**Code commit evaluated:** `fd95950ca734b263e1ce6b1eaef04426e5964732`

**Model tag:** `qwen2.5:3b-instruct` (local Ollama; model digest was not recorded)

**Dataset:** `aegis-synthetic-case-eval-v1`

**Prompt contract:** `analysis-contract-v3b5-schema-v3b10`

**Mode:** provider-level local evaluation, not authenticated HTTP end-to-end

## Method

One operator-confirmed harness execution processed six predeclared slots sequentially: one canonical and one timestamp-only paired observation for each of three source-controlled synthetic case types. The model used the existing provider, model parameters, timeout and concurrency settings. The harness had no database or authenticated HTTP route dependency, did not retry or replace slots, and wrote only sanitized validated fields and metrics to a private ignored report. The private report remains local and is not part of this repository.

Expected labels were defined in source before inference and are **engineering-reviewed, not human-approved ground truth**. Timestamp-paired observations change only timestamps; they are not independent cases. This small smoke evaluation does not estimate production accuracy or reliability.

## Run integrity and contract outcomes

| Measure | Result | Denominator |
|---|---:|---:|
| Planned / attempted / succeeded | 6 / 6 / 6 | 6 planned slots |
| Failed / unattempted | 0 / 0 | 6 planned slots |
| JSON parsing | 6 (100%) | 6 parseable-or-parse-failure observations |
| Strict server schema acceptance | 6 (100%) | 6 parseable model outputs |
| Evidence-reference compliance | 6 (100%) | 6 evidence validations |
| Human-review enforcement | 6 (100%) | 6 accepted or explicitly rejected outputs; all six accepted with review required |
| Provider event correlation | 6 (100%) | 6 attempts |
| Provider failures / failure stages | 0 | 6 attempts |
| Unsafe-rationale rejections | 0 | 6 attempts |

All six accepted results used approved category, priority, team and action values; evidence references were unique members of the fixed case-field allowlist. `humanReviewRequired` was true in every result. Strict application validation remained authoritative. Schema compliance is a contract result, not a measure of classification accuracy.

## Label agreement and observations

| Synthetic case type | Slot | Category | Priority | Team | Next action | Latency | Prompt / output tokens | Confidence / uncertainty |
|---|---|---|---|---|---|---:|---:|---|
| `SYNTHETIC-LOGIN-001` | canonical | incident → incident (match) | high → high (match) | Platform support (match) | match | 5,495 ms | 430 / 126 | 0.9 / moderate |
| `SYNTHETIC-LOGIN-001` | timestamp pair | incident → incident (match) | high → high (match) | Platform support (match) | match | 3,085 ms | 430 / 126 | 0.8 / moderate |
| `SYNTHETIC-BILLING-002` | canonical | billing → billing (match) | medium → high (mismatch) | Billing support (match) | match | 2,912 ms | 426 / 125 | 0.8 / moderate |
| `SYNTHETIC-BILLING-002` | timestamp pair | billing → billing (match) | medium → high (mismatch) | Billing support (match) | match | 2,872 ms | 426 / 134 | 0.8 / moderate |
| `SYNTHETIC-GUIDANCE-003` | canonical | guidance → guidance (match) | low → medium (mismatch) | Customer support (match) | match | 3,343 ms | 427 / 136 | 0.8 / low |
| `SYNTHETIC-GUIDANCE-003` | timestamp pair | guidance → guidance (match) | low → medium (mismatch) | Customer support (match) | match | 2,883 ms | 427 / 134 | 0.8 / low |

| Exact-match metric | Result |
|---|---:|
| Category | 6/6 (100%) |
| Priority | 2/6 (33.33%) |
| Recommended team | 6/6 (100%) |
| Next action | 6/6 (100%) |

By case type, priority agreement was 2/2 for login, 0/2 for billing and 0/2 for guidance. Category, team and action agreement were 2/2 for each type. The repeated priority mismatch is a model-quality concern for human evaluation; it does not by itself establish that the engineering label is correct or that the application validator is defective.

Median latency was **2,999 ms** across six observations. The scorer intentionally did not report p95 because the sample is too small. Prompt tokens totaled 2,566 and generated tokens totaled 781; token usage was available for all six attempts. Model-reported confidence values were 0.9, 0.8, 0.8, 0.8, 0.8 and 0.8, with uncertainty moderate (4) and low (2). Confidence is **uncalibrated**. Evidence references identify case fields only; they are not RAG citations or external grounding.

## Security, scope and limitations

- The run used only invented source-controlled case fixtures and the local loopback Ollama provider. It made no cloud call and did not use the authenticated case endpoint.
- The harness does not establish Auth0 authorization, tenant membership, PostgreSQL RLS, or end-to-end HTTP correlation. Those boundaries remain covered separately by existing deterministic authorization and isolated PostgreSQL tests.
- The successful outputs passed strict schema and evidence validation; no validation rules were relaxed. No recommendation or case action was executed.
- Six observations over three synthetic types are insufficient to claim production accuracy, reliability, fairness, or calibrated confidence. Two rows per case type include one timestamp-only pair, not two independent examples.
- Priority disagreement should be reviewed against a broader, independently labeled synthetic set before considering prompt or model changes. No generation parameters or prompts were changed based on this sample.
- The private report is mode `0600`, its containing evaluation directory is mode `0700`, and the report path is Git-ignored. This checked-in summary contains no prompt, rationale, raw response, token credential, case narrative, or private attempt identifier.

**Readiness statement:** Milestone 3B.16 is complete as a bounded local smoke evaluation. It does not qualify the model for production use. Aegis AI remains development-only and advisory; every result requires human review and no automatic case mutation is implemented.

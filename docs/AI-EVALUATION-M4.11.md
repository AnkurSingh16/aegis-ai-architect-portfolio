# Milestone 4.11: context-complete evaluation design

## Scope and evidence status

This document prepares a new deterministic evaluation dataset and provider input. It does not reinterpret or modify the V1, V2, or V3 reports. Those reports remain immutable evidence about the exact prompts and labels used by their runs. V3's six outputs were structurally accepted, but its evaluator omitted the synthetic case descriptions from model-visible context. Its classification scores therefore measure agreement against predeclared labels under incomplete model input; they do not establish that the model was inaccurate on complete case facts.

The V1, V2, and V3 paired slots differ in timestamps not included in the provider prompt. Each pair is a repeated semantic input, not two independent cases. No statistical or production-quality claim should be based on those six slots.

## Model-visible context boundary

The evaluation may use only the approved synthetic case description from `syntheticCases.description`, the case type and status, and the exact source chunks selected for that scenario. Evaluation-only labels and label rationales stay in scorer code and must never be serialized into provider input or prompt construction.

Case descriptions and document contents are untrusted data. System policy and the strict response contract remain outside and before the serialized data section. The provider input and assembled prompt must be bounded in UTF-8 bytes and reject malformed or non-normalized text. Provider input must not contain tenant authorization decisions; those remain enforced by the authenticated application and database transaction.

The production `StoredCase` model does not persist a case narrative. The route can use an existing synthetic fixture description to form the synthetic retrieval query, but that fixture text is not an observed production narrative and must not be presented as one to the grounded provider. A future production narrative requires a separately reviewed storage/API contract and authorization decision.

The earlier provider-level V3 harness selected sources from a fixed case-type map and injected them directly. It did not execute retrieval or RLS. V3 fixtures also associated billing/guidance sources from Synthetic South with stored-case identity configured for Synthetic North. The new evaluation design must identify the scenario tenant explicitly and reject source/tenant mismatches; provider-level tests still cannot prove database RLS isolation.

## Evidence-to-label review matrix

The case facts below are the exact descriptions in the source-controlled synthetic case catalog. Sources are the currently available source-controlled synthetic catalog entries, version 1. Expected state applies to the complete structured response contract: a supported response requires defensible category, priority, team, action, and citation fields together. A partial plausible classification is not enough to label the whole response SUPPORTED.

| Case | Case-fact provenance | Selected source | Expected state | Expected category / priority / team / action | Evidence and missing evidence | Label review status |
|---|---|---|---|---|---|
| `SYNTHETIC-LOGIN-001` | `syntheticCases.description`: an invented workspace cannot sign in; all synthetic users receive a 503. | `SYNTHETIC-NORTH-LOGIN-INCIDENT`, v1 | `INSUFFICIENT_EVIDENCE` for the complete response | N/A; classification labels are not applicable to an expected abstention. | The case description states broad synthetic impact. The source says to compare the observation with the local service-health timeline and verify scope before assigning severity. No health timeline, severity rubric, or team-ownership rule is supplied. Priority and team are therefore not source-backed as a complete recommendation. | Independently challenged; engineering-reviewed, not human-approved. Existing V3 label is preserved. |
| `SYNTHETIC-BILLING-002` | `syntheticCases.description`: an invented account received two invoices for the same demonstration subscription. | `SYNTHETIC-SOUTH-BILLING-DISCREPANCY`, v1 | `INSUFFICIENT_EVIDENCE` for the complete response | N/A; classification labels are not applicable to an expected abstention. | The facts support a billing discrepancy. The source procedure calls for comparing an invoice identifier and line-item totals against the test ledger, then human confirmation. The case facts provide no invoice identifier, totals, or period. No priority rubric is supplied. The comparison action is a reasonable process suggestion, but the complete response is not established. | Independently challenged; engineering-reviewed, not human-approved. Existing V3 label is preserved. |
| `SYNTHETIC-GUIDANCE-003` | `syntheticCases.description`: an invented user asks where to find the demonstration onboarding guide. | `SYNTHETIC-SOUTH-GENERAL-GUIDANCE`, v1 | `INSUFFICIENT_EVIDENCE` | N/A; classification labels are not applicable to an expected abstention. | The case identifies the question. The available general guidance source does not identify the onboarding guide or its location. A supported answer would require an independently reviewed, versioned synthetic source that names the approved location. No catalog content is changed here. | Independently challenged; engineering-reviewed, not human-approved. Existing V3 label is preserved. |

These labels are an evidence review of the current source/context set, not a claim that a human-approved support policy exists. The current three scenarios are all abstention scenarios under the complete-response contract. They can test abstention behavior, but cannot measure conditional classification quality. A future supported-response dataset needs independently authored synthetic facts and evidence, including a severity rubric and team ownership criteria, before labels are set.

## Scoring rules for the new dataset

Keep contract correctness and decision quality separate. Report each numerator and denominator:

- JSON parse acceptance and strict schema acceptance.
- Supported-response coverage among expected-SUPPORTED scenarios.
- Correct abstention agreement among expected-INSUFFICIENT_EVIDENCE scenarios.
- Conditional category, priority, team, and action accuracy among actual SUPPORTED outputs with applicable expected labels.
- End-to-end agreement for expected-SUPPORTED scenarios, counting abstentions, failures, and missing outputs as misses.
- Citation identity validity, expected source coverage, and independent semantic-grounding review separately.
- Human-review enforcement and operational metrics separately.

Never count an abstention as a correct classification. A zero-denominator metric is `not_measured`, not a pass. Citation identity or source coverage does not demonstrate semantic entailment. Confidence is model-reported and uncalibrated.

## Future evaluation gate

Use a new dataset version and fresh exclusive private report path. Preserve all prior reports and their checksums. Before an operator runs it, require verified PR merge and successful exact-head CI as separate release gates; the local Git source guard alone cannot prove GitHub merge or CI state. The evaluator must require clean reviewed merged `main`, a reviewed-tree identity check, and explicit operator approval in a visible terminal. It remains local-only, synthetic-only, bounded to the reviewed attempt plan, and has no retry or cloud fallback. No report is reserved and no inference is authorized by this design document.

Before a supported-quality evaluation, add a separately versioned, independently reviewed synthetic evidence fixture for each intended supported scenario, or retain the current scenario as expected-insufficient. Do not change catalog documents or historical labels to improve scores.

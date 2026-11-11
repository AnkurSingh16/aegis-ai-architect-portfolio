# Milestone 4.12: balanced grounded quality evaluation

## Purpose and status

This change prepares a new six-case provider-level evaluation. It does not run a model or alter the existing V4 abstention-focused dataset, command, or one-time report. Dataset identity is `aegis-grounded-balanced-v1`; its label status is `engineering-reviewed-not-human-approved`. The evaluator is not model qualification, production accuracy evidence, or authenticated HTTP end-to-end evidence.

The six scenarios are distinct source-controlled synthetic cases, not timestamp variants. Three contain enough invented facts and evaluation-only evidence to support a complete advisory decision; three intentionally omit evidence needed for a complete decision. Paired or repeated observations are not used in this dataset.

## Evidence-to-label matrix

Case facts use provenance `source-controlled-invented-synthetic-cases-v1`. Every source is invented, owned by `Aegis synthetic evaluation corpus`, version 1, revision `aegis-balanced-eval-docs-v1`, and has a SHA-256 over its UTF-8 content. These documents exist only in the evaluation module; they are not production catalog entries and are never ingested. The synthetic tenant is assigned in the scenario and must match every source.

| Scenario | Tenant and case facts | Evidence sources | Expected result and evidence basis | Missing evidence / review status |
|---|---|---|---|---|
| `BALANCED-LOGIN-201` | North. All 12 of 12 synthetic test accounts continuously receive 503 for 24 minutes; the invented status check confirms sign-in service unavailability. | `EVAL-NORTH-LOGIN-SEVERITY-V1`; `EVAL-NORTH-LOGIN-STATUS-V1` | `SUPPORTED`: incident, high, Platform support, “Review the synthetic service impact and incident timeline.” The invented criteria explicitly set high at all tenant test accounts blocked for more than 15 minutes, identify Platform support ownership, and permit this advisory review action. Both impact and service state are evidenced. | None of the required synthetic criteria are missing. Engineering-reviewed; independent challenge agreed subject to the explicit 12/12 and continuous-duration facts. Not human-approved. |
| `BALANCED-LOGIN-202` | South. One synthetic account reports sign-in failure; affected-account count, duration, error code, and status are unknown. | `EVAL-SOUTH-LOGIN-SCOPE-V1`; `EVAL-SOUTH-LOGIN-STATUS-V1` | `INSUFFICIENT_EVIDENCE`. The source requires scope, duration, and a status observation before assigning a complete recommendation. | Scope, duration, and service status are missing. Engineering-reviewed; independent challenge agreed. Not human-approved. |
| `BALANCED-BILLING-301` | South. Two invented invoice IDs share subscription, period, and a $125 line; the synthetic ledger confirms both; synthetic service check reports no disruption. | `EVAL-SOUTH-BILLING-REVIEW-V1`; `EVAL-SOUTH-BILLING-LEDGER-V1`; `EVAL-SOUTH-BILLING-STATUS-V1` | `SUPPORTED`: billing, medium, Billing support, “Compare the synthetic invoice records before taking any billing action.” The fixture maps a ledger-confirmed duplicate without service impact to those advisory labels and action. | Required identifiers, period, amount, ledger confirmation, and no-disruption status are all present. Engineering-reviewed; independent challenge agreed after explicitly including the bounded no-disruption check. Not human-approved. |
| `BALANCED-BILLING-302` | North. An invented contact suspects a duplicate; invoice IDs, period, line totals, and ledger result are unavailable. | `EVAL-NORTH-BILLING-REQUIREMENTS-V1`; `EVAL-NORTH-BILLING-LEDGER-V1` | `INSUFFICIENT_EVIDENCE`. The source requires identifiers, period, totals, and ledger comparison before a duplicate, priority, team, or action can be justified. | Required comparison inputs and ledger result are missing. The fixture does not claim a negative ledger lookup. Engineering-reviewed; independent challenge agreed. Not human-approved. |
| `BALANCED-GUIDANCE-401` | North. An invented new training user asks how to enroll a demonstration MFA device and reports no access problem. | `EVAL-NORTH-GUIDANCE-INDEX-V1`; `EVAL-NORTH-GUIDANCE-ROUTING-V1` | `SUPPORTED`: guidance, low, Customer support, “Have a support agent review and share the approved onboarding guide.” The invented approved guide gives its location and MFA steps; policy maps a fully identified informational request without access impact to the labels. | The guide and requested topic are identified. Engineering-reviewed; independent challenge agreed. Not human-approved. |
| `BALANCED-GUIDANCE-402` | South. An invented user asks for a reimbursement-policy guide location; no title, owner, or location is supplied. | `EVAL-SOUTH-GUIDANCE-INDEX-V1`; `EVAL-SOUTH-GUIDANCE-BOUNDARY-V1` | `INSUFFICIENT_EVIDENCE`. Retrieved evidence does not identify the requested guide or its location. This does not claim that the guide does not exist. | No matching authorized evidence establishes the answer. Engineering-reviewed; independent challenge agreed. Not human-approved. |

The supported cases use explicit evaluation-only severity/priority and ownership criteria and only the existing permitted next-action enums. The next action is advisory; no support action is executed. The independent challenge required clarification of continuous login impact, a synthetic no-disruption billing check, and careful wording that missing guidance evidence does not prove a document is nonexistent. Those clarifications are included above and in the fixtures.

## Model-visible data boundary

The runner constructs a narrow provider input containing only `caseType`, `caseStatus`, `caseFacts`, and source records with request-scoped citation IDs, title, version, position, and content. It does not pass scenario IDs, tenant metadata, expected state, expected labels, expected-source identities, label rationale, or review status. The existing grounded provider treats case facts and source content as untrusted data. The existing `oneOf` schema and authoritative server parser remain unchanged; citation IDs must belong to the current source bundle, and human review remains mandatory.

These invented evaluation sources are not production sources. Production stored cases still do not carry a narrative; this evaluation must not be used to imply that production case facts have been added.

## Separate release and report identities

- Dataset: `aegis-grounded-balanced-v1`
- Local command: `npm run ai:evaluate:grounded:balanced:local -w apps/api`
- New one-time report: `.local/evaluations/milestone-4.12-grounded-balanced-qwen2.5-3b-instruct-v1.json`
- Source guard: clean `main`, equal to fetched `origin/main`, ancestry from base `51dfcd9fb97a8c3fff27e90591f680e25ebfee53`, and exact tree equality with the preserved reviewed branch `origin/feat/m4-grounded-balanced-quality`.

The report is not reserved by tests or preparation. When separately authorized, the evaluator requires `NODE_ENV=development`, both AI opt-ins, the already-installed `qwen2.5:3b-instruct` model, loopback Ollama, a 15-second timeout, concurrency one, no proxy mode, and a visible terminal confirmation: `RUN SIX BALANCED GROUNDED EVALUATIONS`. It reserves the report exclusively with private permissions after confirmation. It makes at most one request for each of the six distinct scenarios, has no retry/replacement path, and stores only allowlisted validated fields and metrics. It has no database or cloud provider path.

## Scoring

The scorer separates contract checks from decision quality and reports a numerator, denominator, and measured/not-measured state for each rate:

- JSON parsing and strict schema acceptance are computed only over attempts where that stage was reached.
- Supported coverage denominator is the three expected-supported cases. Correct-abstention denominator is the three expected-insufficient cases. An abstention on an expected-supported case is separately counted as incorrect and is an end-to-end miss.
- Conditional category, priority, team, and next-action accuracy uses accepted `SUPPORTED` outputs from expected-supported cases with the corresponding predeclared label. It does not treat absent labels or abstentions as correct.
- Incorrect supported answers count wrong label bundles on expected-supported cases and any `SUPPORTED` answer on an expected-insufficient case. Their rate denominator is all accepted decisions; the two components retain their own expected-population denominators. Provider failures are reported separately.
- End-to-end supported-decision agreement requires the expected-supported state and all four exact labels; its denominator remains all three expected-supported cases, so abstentions, failures, and wrong supported labels count as misses. Overall agreement separately combines correct supported decisions and correct abstentions over the six planned cases.
- `citationIdentityValidity` measures supported outputs whose citation identities reached validation, including rejected invalid-citation responses; abstentions have no citation IDs and are excluded. Expected-source coverage counts expected supporting source identities cited by supported answers against the seven source identities expected by the three supported scenarios. These identity checks do not establish semantic entailment.
- Human-review enforcement and provider correlation are measured independently. Latency and available token counts are reported per observation and in aggregates. p95 is not reported for this six-attempt sample. Independent semantic-grounding review is explicitly `NOT_MEASURED`.

## Limitations and later operator procedure

Three supported and three abstention cases provide a balanced diagnostic smoke set, not statistically reliable production evidence. Labels are engineering-reviewed, not human-approved. All cases and documents are synthetic. Provider-level execution is not authenticated HTTP E2E, does not establish Auth0 or RLS behavior, and does not prove semantic groundedness. Model confidence is not calibrated probability.

After this branch is reviewed, merged, and exact-head CI passes, a separate operator authorization is still required for one local run. The operator must use a visible terminal, inspect the new report path is absent, provide the command's exact confirmation, and then preserve the private report. No model execution is part of this PR.

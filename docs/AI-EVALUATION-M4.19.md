# Milestone 4.19: deterministic evidence-to-decision audit

## Purpose and limits

This evaluation-only audit makes the evidence review for the existing six synthetic grounded-AI scenarios explicit and reproducible. It validates fixture provenance and resolves human-authored field assessments to the current case facts and source fixtures. It does not decide whether a model should answer, generate recommendations, change prompts, call a provider, or write a report. It is not a production evidence-sufficiency gate.

The audit can show that an engineering-authored assessment refers to current, versioned fixture evidence. It cannot prove semantic entailment, model accuracy, or that the labels are independently approved. Evidence judgments remain pending independent human review.

## Corrected historical baseline

The M4.15 and M4.18 Billing 301 attempts parsed as JSON but were rejected by the application parser with `invalid_confidence`. Neither is an accepted abstention. The value is not preserved and must not be inferred. M4.17 accepted all six contracts, but all six responses abstained.

| Run | JSON parsed | Contract accepted | Supported coverage | Correct abstentions | Incorrect abstentions | Billing 301 |
|---|---:|---:|---:|---:|---:|---|
| M4.15 | 6/6 | 5/6 | 0/3 | 3/3 | 2/3 | Rejected: `invalid_confidence` |
| M4.17 | 6/6 | 6/6 | 0/3 | 3/3 | 3/3 | Accepted abstention; all six abstained |
| M4.18 | 6/6 | 5/6 | 0/3 | 3/3 | 2/3 | Rejected: `invalid_confidence` |

These are small descriptive synthetic runs. They do not identify a causal mechanism, establish production accuracy, or demonstrate semantic groundedness. In particular, there is no accepted supported response from which to measure conditional classification accuracy or citation validity on a supported answer.

## Provenance and review status

The audit consumes the unchanged `aegis-grounded-balanced-v1` fixtures. Cases use provenance `source-controlled-invented-synthetic-cases-v1`; source fixtures use revision `aegis-balanced-eval-docs-v1`, version 1, and owner `Aegis synthetic evaluation corpus`. Each source fixture contains a content SHA-256. The audit validates that the referenced source identity, version, revision, tenant, and content hash still resolve to the current fixture. Case facts are also checked against their stored hash.

Every assessment cites either the case-fact hash, a source identity with its version/revision, or the fixed human-review contract. The module accepts a projection that excludes expected labels and review rationales. It returns `engineering_reviewed_pending_independent_review`; no machine test or Codex review upgrades that status to human-approved.

## Field-level evidence matrix

States mean:

- `EXPLICIT_SUPPORT`: the cited case fact/source text directly supplies the relevant criterion or permitted advisory action.
- `TAXONOMY_MAPPING_REQUIRED`: evidence is present, but a reviewer must map its meaning to a fixed output taxonomy. This is never silently upgraded to explicit support.
- `MISSING_EVIDENCE`: a cited source criterion identifies facts or records that are absent.
- `AMBIGUOUS`: current evidence does not settle the mapping or conclusion.
- `NOT_APPLICABLE`: the field is not a source-evidence fact assessed by this audit; this also covers fields absent from an abstention assessment.

| Scenario | Category | Priority | Team | Next action | Rationale / abstention basis | Provenance, tenant, revision | Missing evidence / mapping review |
|---|---|---|---|---|---|---|---|
| `BALANCED-LOGIN-201` (North; expected-supported fixture) | `TAXONOMY_MAPPING_REQUIRED`: sign-in service interruption must map to the `incident` enum. Refs: `EVAL-NORTH-LOGIN-SEVERITY-V1`, `EVAL-NORTH-LOGIN-STATUS-V1`. | `EXPLICIT_SUPPORT`: facts say all 12 test accounts were blocked for 24 minutes and status confirms unavailability; source threshold is all accounts and more than 15 minutes. Refs: case facts, `EVAL-NORTH-LOGIN-SEVERITY-V1`, `EVAL-NORTH-LOGIN-STATUS-V1`. | `EXPLICIT_SUPPORT`: sign-in service owner is Platform support. Ref: `EVAL-NORTH-LOGIN-SEVERITY-V1`. | `EXPLICIT_SUPPORT`: permitted advisory action is to review synthetic impact and timeline; no automatic escalation/case change. Ref: `EVAL-NORTH-LOGIN-SEVERITY-V1`. | `EXPLICIT_SUPPORT`: case measurements and status can support a cited explanation. Ref: case facts and both sources. Human verification is required. | Case provenance and hash, North tenant, source version 1/revision v1, and content hashes are validated. | No priority facts are missing. Category-to-enum mapping remains a review item; the source does not literally name `incident`. |
| `BALANCED-LOGIN-202` (South; expected-insufficient fixture) | `MISSING_EVIDENCE`: do not assign a supported classification from one unverified report. Refs: case facts, `EVAL-SOUTH-LOGIN-SCOPE-V1`. | `MISSING_EVIDENCE`: affected-account count and duration are unknown; no approved status observation. Refs: case facts, `EVAL-SOUTH-LOGIN-SCOPE-V1`, `EVAL-SOUTH-LOGIN-STATUS-V1`. | `MISSING_EVIDENCE`: ownership cannot be assigned before scope/status are established. Ref: `EVAL-SOUTH-LOGIN-SCOPE-V1`. | `MISSING_EVIDENCE`: investigation step requires scope, duration, and status. Refs: both sources. | `EXPLICIT_SUPPORT` for the abstention basis: sources say not to infer an outage and identify absent inputs. | Case provenance and hash, South tenant, source version 1/revision v1, and content hashes are validated. | Affected-account count, duration, error code, and relevant status result are absent. |
| `BALANCED-BILLING-301` (South; expected-supported fixture) | `TAXONOMY_MAPPING_REQUIRED`: duplicate invoice evidence must map to the `billing` enum. Refs: `EVAL-SOUTH-BILLING-REVIEW-V1`, `EVAL-SOUTH-BILLING-LEDGER-V1`. | `EXPLICIT_SUPPORT`: source says the ledger-verified duplicate with no service disruption is medium priority. Refs: all three billing sources. | `EXPLICIT_SUPPORT`: source assigns Billing support ownership. Ref: `EVAL-SOUTH-BILLING-REVIEW-V1`. | `EXPLICIT_SUPPORT`: compare invoice records before any billing action; no refund or balance change. Ref: `EVAL-SOUTH-BILLING-REVIEW-V1`. | `EXPLICIT_SUPPORT`: invoice identifiers, same subscription/period/amount, ledger match, and service status support an explanation. Refs: case facts and all three sources. Human billing review is required. | Case provenance and hash, South tenant, source version 1/revision v1, and content hashes are validated. | No material evidence item is identified as missing. Literal enum mapping remains reviewable; it is not inferred from the historical model response. |
| `BALANCED-BILLING-302` (North; expected-insufficient fixture) | `MISSING_EVIDENCE`: suspected duplicate is not confirmed. Refs: case facts, `EVAL-NORTH-BILLING-REQUIREMENTS-V1`. | `MISSING_EVIDENCE`: policy says priority cannot be established without record comparison. Ref: `EVAL-NORTH-BILLING-REQUIREMENTS-V1`. | `MISSING_EVIDENCE`: responsible team cannot be established without comparison. Ref: same source. | `MISSING_EVIDENCE`: no billing action is justified without invoice/ledger evidence. Refs: both sources. | `EXPLICIT_SUPPORT` for abstention: source explicitly disallows inferring a duplicate, refund, or balance change. | Case provenance and hash, North tenant, source version 1/revision v1, and content hashes are validated. | Invoice identifiers, period, line-item amount, and ledger result are absent. |
| `BALANCED-GUIDANCE-401` (North; expected-supported fixture) | `TAXONOMY_MAPPING_REQUIRED`: an MFA onboarding information request must map to the `guidance` enum. Refs: `EVAL-NORTH-GUIDANCE-INDEX-V1`, `EVAL-NORTH-GUIDANCE-ROUTING-V1`. | `EXPLICIT_SUPPORT`: source sets low priority for informational requests with an identified guide and no access/service impact. Refs: case facts and routing source. | `EXPLICIT_SUPPORT`: source assigns Customer support. Ref: `EVAL-NORTH-GUIDANCE-ROUTING-V1`. | `EXPLICIT_SUPPORT`: source permits an agent to review and share the approved guide; the assistant does not share automatically. Ref: routing source. | `EXPLICIT_SUPPORT`: the guide topic/location and no-impact facts support a cited explanatory rationale. Refs: case facts and both sources. | Case provenance and hash, North tenant, source version 1/revision v1, and content hashes are validated. | No material evidence item is identified as missing. Category-to-enum mapping remains a reviewer judgment. |
| `BALANCED-GUIDANCE-402` (South; expected-insufficient fixture) | `MISSING_EVIDENCE`: no matching approved reimbursement guide is established. Refs: case facts, `EVAL-SOUTH-GUIDANCE-INDEX-V1`. | `MISSING_EVIDENCE`: no approved source supports impact/priority assignment. Refs: both guidance sources. | `MISSING_EVIDENCE`: the guide owner is not established. Ref: `EVAL-SOUTH-GUIDANCE-INDEX-V1`. | `MISSING_EVIDENCE`: guide location/content cannot be supplied; source directs human review. Refs: both sources. | `EXPLICIT_SUPPORT` for abstention: inventory and boundary sources disallow inventing a guide or location. | Case provenance and hash, South tenant, source version 1/revision v1, and content hashes are validated. | Matching guide entry, owner, and location are absent. |

Human review is required by the output contract for every supported recommendation. For insufficient-evidence cases, the source documents reinforce review boundaries; the audit does not perform or replace human review.

Confidence and uncertainty are represented as `NOT_APPLICABLE` in this source-evidence audit: they are assessment outputs, not facts the source documents must state. The audit assigns neither a confidence value nor an uncertainty level.

## Schema and parser compatibility

The provider sends a two-branch `oneOf` schema. SUPPORTED requires populated decision fields, numeric confidence from 0 to 1, citations, and mandatory human review. INSUFFICIENT_EVIDENCE requires null decision fields and confidence, an empty citation list, high uncertainty, and human review.

The application parser is authoritative. It first validates object shape and required/unexpected fields, then human review and grounding state. It accepts only the exact abstention shape. For SUPPORTED it validates field types and taxonomy enums, safe rationale, confidence type/finiteness/range, then citation array shape/count/UUID format/uniqueness/request membership. The schema's confidence range agrees in intent with the parser. The parser deliberately adds checks the schema cannot express for request-scoped citation membership and safe rationale.

Historical Billing 301 failures reached the confidence check after JSON parsing and earlier SUPPORTED validations. `invalid_confidence` does not expose the rejected value, and the audit does not infer it. There is no confirmed confidence schema/parser mismatch and no evidence that the root cause is solved. Ollama/llama.cpp structured-schema implementation details and version-specific runtime behavior are not established by these deterministic source checks.

## Security and isolation

- The audit imports only evaluation fixtures and pure validation code; it is not imported by API routes or provider factories.
- Inputs omit expected output labels and review rationales; those fields are not consulted for field evidence assessments.
- Source identity, tenant, version, revision, and content hashes are checked before resolving evidence references.
- An invalid or unresolved reference fails closed instead of being treated as support.
- The audit has no network, Ollama, cloud, database, report-write, or action-execution dependency.
- It does not change prompts, output schemas, confidence handling, citation validation, production routing, or evaluator behavior.

## Acceptance criteria and independent review

Deterministic tests must verify the six fixed IDs, source identities/versions/content hashes, tenant isolation, field references, missing-evidence findings, preserved taxonomy ambiguity, label/rationale independence, and fail-closed handling of tampered or absent provenance. Parser regression cases must cover confidence boundaries and invalid types, citations, and human-review enforcement without provider calls. Tests also verify no report writes, no provider/model calls, and unchanged historical evaluator and production contracts.

Passing tests show only that the audit implementation conforms to its deterministic review rules. An independent human reviewer must approve the evidence judgments before their review status can change. Any ambiguity must remain visible; labels must not be altered to match prior model outputs.

## Future evaluation design

If a later evaluation is proposed, it must use a new versioned report path, reviewed merged source identity, immutable historical reports, predeclared descriptive metrics, independent semantic review, and separate operator authorization. Compare M4.18 primarily with M4.15 and treat M4.17 as separate historical context. A single six-case run cannot establish causality or production quality. Do not claim improved supported-answer quality from this deterministic audit.

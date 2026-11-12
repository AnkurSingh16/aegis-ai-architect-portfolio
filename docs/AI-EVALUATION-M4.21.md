# Milestone 4.21: grounded output contract conformance

## Purpose and boundary

This deterministic test suite compares the existing `groundedAnalysisSchema` with the authoritative `parseGroundedProviderOutput` application parser. It uses Ajv 6, already present in the API workspace, plus synthetic in-memory objects. It does not edit either contract, call a provider, run an evaluation, create a report, or verify Ollama/llama.cpp runtime behavior.

The schema has no explicit `$schema` declaration. The tests compile it with the installed Ajv 6 defaults (JSON Schema draft-07), with type coercion and additional-property removal disabled. The tested object is the actual exported schema; no duplicate schema is maintained. The application parser remains authoritative.

## Contracts under test

Both `oneOf` branches require the same ten keys and reject additional properties. The branches are disjoint by `groundingState`:

- **SUPPORTED:** taxonomy enums, non-empty rationale up to 700 characters, 1–5 string citations, numeric confidence from 0 through 1, allowed uncertainty, and `humanReviewRequired: true`.
- **INSUFFICIENT_EVIDENCE:** decision fields and confidence are null, citations are empty, uncertainty is `high`, and human review is true.

The parser also requires a supported confidence to be a finite number, validates citation UUID-v4 shape, uniqueness and membership in the current request's sources, and applies a rationale safety filter. These runtime application checks are stricter than the static schema by design.

## Conformance case matrix

“Schema” is Ajv acceptance of the actual exported schema. “Parser” is acceptance by `parseGroundedProviderOutput`; rejection categories are the parser's fixed `validationReason` values. `A` means both accept, `B` both reject, `C` schema accepts while an intentional application-only rule rejects, and `OUT-OF-JSON` marks JavaScript non-finite values that are not representable in JSON. The suite asserts the outcomes and rejection reasons for every row.

| Case | Schema | Parser | Parser rejection | Class | Intended difference |
|---|---:|---:|---|---|---|
| Canonical SUPPORTED | Accept | Accept | — | A | No |
| Canonical abstention | Accept | Accept | — | A | No |
| Supported confidence 0 | Accept | Accept | — | A | No |
| Supported confidence 1 | Accept | Accept | — | A | No |
| Supported confidence 0.5 | Accept | Accept | — | A | No |
| Confidence 1.01 | Reject | Reject | `invalid_confidence` | B | No |
| Confidence -0.01 | Reject | Reject | `invalid_confidence` | B | No |
| String confidence | Reject | Reject | `invalid_confidence` | B | No coercion |
| Null SUPPORTED confidence | Reject | Reject | `invalid_confidence` | B | No |
| Missing confidence | Reject | Reject | `missing_required_field` | B | No |
| NaN confidence (not JSON) | Reject | Reject | `invalid_confidence` | OUT-OF-JSON | Defensive boundary case |
| Positive infinity confidence (not JSON) | Reject | Reject | `invalid_confidence` | OUT-OF-JSON | Defensive boundary case |
| Negative infinity confidence (not JSON) | Reject | Reject | `invalid_confidence` | OUT-OF-JSON | Defensive boundary case |
| Extra field | Reject | Reject | `unexpected_field` | B | No |
| Missing required rationale | Reject | Reject | `missing_required_field` | B | No |
| Wrong category enum | Reject | Reject | `unsupported_enum` | B | No |
| Wrong priority enum | Reject | Reject | `unsupported_enum` | B | No |
| Wrong team enum | Reject | Reject | `unsupported_enum` | B | No |
| Wrong next-action enum | Reject | Reject | `unsupported_enum` | B | No |
| Wrong grounding state | Reject | Reject | `invalid_grounding_state` | B | No |
| Mixed SUPPORTED/abstention fields | Reject | Reject | `invalid_field_type` | B | No |
| Missing supported citations | Reject | Reject | `missing_citation` | B | No |
| Duplicate supported citations | Accept | Reject | `duplicate_citation` | C | Yes: parser uniqueness rule |
| Unknown request citation | Accept | Reject | `unknown_citation` | C | Yes: request membership |
| Malformed citation ID | Accept | Reject | `invalid_citation_format` | C | Yes: UUID-v4 rule |
| Unsafe rationale | Accept | Reject | `unsafe_rationale` | C | Yes: rationale safety policy |
| Whitespace-only rationale | Accept | Reject | `unsafe_rationale` | C | Yes: non-blank text rule |
| Human review false | Reject | Reject | `invalid_human_review` | B | No |
| Invalid uncertainty enum | Reject | Reject | `unsupported_enum` | B | No |
| Abstention with populated classification | Reject | Reject | `invalid_state_combination` | B | No |
| Abstention with non-null confidence | Reject | Reject | `invalid_state_combination` | B | No |
| Abstention with citations | Reject | Reject | `invalid_state_combination` | B | No |
| Syntactically valid citation from another request | Accept | Reject | `unknown_citation` | C | Yes: request membership |
| Schema-valid unsafe rationale (second case) | Accept | Reject | `unsafe_rationale` | C | Yes: rationale safety policy |

No unexpected schema/parser mismatch is expected in this matrix. Non-finite numbers are checked without JSON serialization; `NaN` and infinities are not JSON values. Their Ajv result is recorded as a defensive JavaScript-boundary observation, not evidence about JSON wire behavior.

## Interpretation and limitations

The `oneOf` branches encode two mutually exclusive output shapes. Ajv tests show how the in-process schema validator evaluates these objects. They do **not** establish that a particular Ollama or llama.cpp version honors `oneOf` during constrained generation. This task performs no Ollama runtime verification.

The application-only divergences are intentional safety checks, not reasons to weaken the parser or expand the schema. In particular, static JSON Schema cannot know the request's citation set. The parser's citation membership, UUID-v4, uniqueness, and rationale safety rules must remain authoritative.

Historical M4.15 and M4.18 Billing 301 outputs were rejected as `invalid_confidence`. Their rejected confidence values were not retained; this suite does not reconstruct them. The repeated failure category remains evidence of a contract rejection, not proof of its cause. M4.17 achieved 6/6 contract acceptance but all six outputs abstained. The over-abstention problem remains unresolved.

Independent human review of the M4.19 evidence judgments is still pending. Deterministic conformance tests do not approve those judgments, prove semantic entailment, verify structured generation at runtime, or establish model accuracy.

## Verification plan

The suite should run with the API unit tests and existing lint, typecheck, coverage, and build gates. No model request, database integration against a local service, report write, or source-contract modification is part of this work. Any runtime structured-output experiment would require separate authorization and a fresh versioned evaluation report.

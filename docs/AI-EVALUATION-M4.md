# Milestone 4 grounded evaluation

## Deterministic evaluation contract

The source-controlled suite keeps retrieval evaluation separate from grounded provider evaluation. The original `aegis-grounded-provider-v1` plan contains six fixed in-memory synthetic slots, two observations for each canonical login, billing, and guidance case type. Expected category, priority, team, action, grounding state, and source identity are engineering-reviewed labels, not human-approved ground truth. Paired observations are not independent support cases.

The scorer reports parsing, strict schema acceptance, citation validity, expected-source coverage, grounding-state agreement, category/priority/team/action agreement, human review, provider correlation, failure-stage distribution, latency, and available token counts with denominators. Null or inapplicable metrics remain `not_measured`; p95 is omitted for six observations. Citation identity and source coverage do not prove semantic entailment. Confidence is model-reported and uncalibrated.

## Observed v1 run

The private one-time report was created at `.local/evaluations/milestone-4-grounded-qwen2.5-3b-instruct.json` for commit `ca1a62aecf3ecd388afbbe4515d1dfcbe30d0105`, tree `8ddcdc5fb740100236d5a3b819080dfc107d8876`, model `qwen2.5:3b-instruct`, dataset `aegis-grounded-provider-v1`. It records 6 planned, 6 attempted, 0 successful, 6 failed, and 0 unattempted slots. All six outputs parsed as JSON, but strict schema acceptance was 0/6. All failures were `output_schema` with broad `schemaReason=invalid_output`; none were `invalid_citations`. The fixed report did not retain rejected output values, so it cannot identify the exact field-level predicate. Per-case failures were 2/2 for login, 2/2 for billing, and 2/2 for guidance.

Provider event correlation was 6/6. Median latency was 2,961 ms across six samples; p95 was not reported. Token counts were unavailable. Citation validity, expected-source coverage, grounding-state agreement, classification/priority/team/action agreement, and accepted-output human-review enforcement were not measured. The run is evidence of a schema interoperability problem for this exact model/source run, not a model-accuracy estimate. The prior Milestone 3B priority agreement of 2/6 remains a separate known limitation.

## Observed v2 run and contract diagnosis

The private v2 report records commit `fc91c2e964ce070112afe55cc7704b4db1066989`, tree `f1e8d2cf7aa6b8e8955635a94f95d39b52f1a9e9`, dataset `aegis-grounded-provider-v2`, and model `qwen2.5:3b-instruct`. It records 6 planned, 6 attempted, 0 successful, 6 failed, and 0 unattempted slots. All six parsed as JSON and failed at `output_schema`; the fixed validation reasons were `invalid_state_combination` (5) and `invalid_field_type` (1). Correlation was 6/6 and median latency was 2,507 ms. Token counts were unavailable. No transport, timeout, or JSON parse failures were recorded. The report does not retain rejected values, so the specific field responsible for the one `invalid_field_type` result cannot be determined. The v1 report remains immutable.

The former request schema allowed nullable classification fields and citations with zero items independently of `groundingState`. Consequently, JSON-schema-valid objects could be rejected by the parser: an `INSUFFICIENT_EVIDENCE` object with a non-null classification was rejected as `invalid_state_combination`; a `SUPPORTED` object with a null required classification was rejected as `invalid_field_type`; and a `SUPPORTED` object with no citations was rejected as `missing_citation`. The report proves the first two classes occurred, but not the exact value or field in the single type failure. The server parser's strict state, citation-membership, rationale-safety, and human-review checks remain authoritative.

The generation schema now separates `SUPPORTED` and `INSUFFICIENT_EVIDENCE` into disjoint `oneOf` shapes. Supported output requires non-null classifications, rationale, next action, confidence, uncertainty, and at least one citation. Abstention requires null classifications/action/rationale/confidence, an empty citation array, high uncertainty, and mandatory human review. The prompt spells out these same two shapes. This aligns generation constraints with the existing parser without accepting or repairing additional outputs. Request-specific citation membership and rationale safety cannot be decided by a fixed schema and remain server-side checks.

Ollama's official API documentation specifies that structured output accepts a JSON Schema object in `format`, but does not enumerate every supported schema keyword. The upstream llama.cpp schema converter currently handles `oneOf` by compiling its alternatives into a grammar. The two Aegis branches are discriminated by mutually exclusive `groundingState` enums. This source-level support is useful compatibility evidence, not proof that every Ollama build or backend honors the keyword identically. No runtime inference or live schema probe was performed for this correction; exact Ollama/model behavior remains for a separately authorized evaluation.

## CLI completion and exit status

The v2 artifact says `completed`, 6 attempted, and 0 unattempted; that status means every planned slot received an outcome, not that any model output passed validation. In the merged CLI, a completed six-failure run maps to exit code 0, while a stopped/incomplete run maps to exit code 1. A deterministic mocked runner reproduces this distinction. The saved report does not include the observed shell exit code or an exception stage, so the actual reason the operator saw exit code 1 cannot be identified from this evidence. A failure after final report persistence, such as summary output or file-handle close, is possible but unconfirmed. The CLI now emits only a fixed lifecycle stage on such exceptions to make a future run diagnosable without logging model content or raw errors.

## V3 evaluation proposal

No v3 evaluation is authorized by this change. After review and merge, a separately approved v3 run should use a new private one-time report path, for example `.local/evaluations/milestone-4.8-grounded-qwen2.5-3b-instruct-v3.json`, and a new dataset/report version `aegis-grounded-provider-v3`. It must require clean `main` equal to `origin/main`, valid ancestry from the reviewed release base, and exact equality to the merged reviewed release tree; preserve v1 and v2 reports; use only the same local model and synthetic in-memory data; perform at most six sequential slots with one request per slot and no retries; require visible TTY confirmation; and store only sanitized aggregate/validated fields and fixed diagnostics.

The first v3 acceptance gates are JSON parsing, strict schema acceptance, and reason-code counts with explicit denominators. Citation validity, evidence coverage, and classification metrics apply only to accepted outputs. Rejected output stays failed and is never repaired into a success. Run exact oneOf-shape unit tests and mocked provider tests in CI before operator evaluation. The evaluation remains a provider-level smoke test: it does not validate Auth0, membership, RLS, authenticated HTTP behavior, or semantic entailment. Six observations do not establish production accuracy or reliability.

## Operator gate

The v2 report path is already reserved and must never be reused. After a future reviewed v3 release and separate authorization, the operator command should be:

```sh
NODE_ENV=development \
AEGIS_AI_ENABLED=true \
AEGIS_GROUNDED_AI_ENABLED=true \
AEGIS_OLLAMA_MODEL=qwen2.5:3b-instruct \
npm run ai:evaluate:grounded:local -w apps/api
```

The runner must independently require a visible TTY and the exact phrase `RUN SIX GROUNDED EVALUATIONS`. Do not bypass the prompt. Before v3, update the one-time report path and source identity to the exact merged release; neither is changed to permit reuse of the consumed v2 path.

Ordinary tests and CI use deterministic mocks only. They do not call Ollama, download models, access `aegis_local`, or require cloud services.

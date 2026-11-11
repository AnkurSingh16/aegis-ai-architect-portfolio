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

## V3 evaluation preparation

This change prepares, but does not run, v3. It uses the fresh private one-time path `.local/evaluations/milestone-4.8-grounded-qwen2.5-3b-instruct-v3.json` and report/dataset version `aegis-grounded-provider-v3`. Exclusive creation refuses an existing report. The private report directory and file remain mode 0700 and 0600, respectively; symlinked or unsafe paths fail closed. The v1 and v2 paths and artifacts are preserved.

The v3-only source guard rejects feature-branch execution. It requires a clean `main`, exact equality between `HEAD` and fetched `origin/main`, ancestry from the PR #46 merge commit `c9ce3085d19ab75128c841bc8d9f5066042bdff3`, and tree equality with the preserved `origin/feat/m4-grounded-evaluation-v3` branch. This lets the source guard verify the reviewed source tree after squash merge without embedding an unknown future merge SHA. The guard proves Git source identity and ancestry; PR merge status and exact-head CI remain separate release checks that the operator must verify before a future run.

The evaluator keeps the same local model, six fixed in-memory synthetic slots, one sequential provider request per slot, no retries, a 15-second timeout, concurrency one, and visible TTY confirmation. It has no persistent database path. The one-time report stores only sanitized measurements and validated output fields, never prompts, source text, rationale, rejected output, or credentials.

The first v3 acceptance gates are JSON parsing, strict schema acceptance, and fixed validation-reason counts with explicit denominators. Citation validity, evidence coverage, and classification metrics apply only to accepted outputs. Rejected output stays failed and is never repaired into a success. Deterministic oneOf-shape and mocked-provider tests run in CI before any separately authorized operator evaluation. The evaluation remains a provider-level smoke test: it does not validate Auth0, membership, RLS, authenticated HTTP behavior, or semantic entailment. Six observations do not establish production accuracy or reliability. Historical v1 and v2 results remain 0/6 strict schema acceptance; prior Milestone 3B priority agreement remains 2/6. This preparation makes no claim that the model has improved.

## Operator gate

The v2 report path is already reserved and must never be reused. After this v3 PR is merged, exact-head CI is green, local main equals origin/main at the reviewed tree, and a separate inference authorization is provided, the operator command is:

```sh
NODE_ENV=development \
AEGIS_AI_ENABLED=true \
AEGIS_GROUNDED_AI_ENABLED=true \
AEGIS_OLLAMA_MODEL=qwen2.5:3b-instruct \
npm run ai:evaluate:grounded:local -w apps/api
```

The runner independently requires a visible TTY and the exact phrase `RUN SIX GROUNDED EVALUATIONS`. Do not bypass the prompt. It reserves the v3 path only after source/runtime/model preflight and successful operator confirmation. A missing or invalid preflight must not consume the report path or start generation.

Ordinary tests and CI use deterministic mocks only. They do not call Ollama, download models, access `aegis_local`, or require cloud services.

## Context-complete dataset review

Milestone 4.11 preserves these historical V1–V3 records and introduces a separately versioned context-complete dataset design. The new evidence matrix, case-fact boundary, source/tenant checks, scoring denominators, and future evaluation gate are documented in [AI-EVALUATION-M4.11.md](./AI-EVALUATION-M4.11.md). No V4 inference has been performed or authorized by that preparation.

# Milestone 4 grounded evaluation

The source-controlled deterministic suite keeps retrieval evaluation separate from grounded provider evaluation. `aegis-grounded-provider-v1` uses six fixed in-memory synthetic slots: two observations for each canonical login, billing, and guidance case type. The expected category, priority, team, action, supported state, and relevant source identity are declared from the engineering-reviewed fixture rubric before any model output. The paired slots are repeated observations, not six independent support cases.

The pure scorer reports JSON parsing, strict schema acceptance, citation validity, expected-source coverage, grounding-state agreement, category/priority/team/action agreement, mandatory human review, request-event correlation, fixed failure-stage counts, latency, and available token samples. Every rate includes numerator and denominator. Missing observations remain `not_measured`; p95 is omitted for this six-slot sample. Confidence values, when present in a private report, are model-reported and uncalibrated. Groundedness-review agreement remains not measured until an independent reviewer supplies that assessment; citation identity and source coverage do not prove semantic entailment.

## Optional local provider evaluation

The runner is a provider-level smoke evaluation. It uses only the source-controlled synthetic catalog in memory, the existing loopback Ollama provider, and no database, authenticated HTTP route, or tenant authorization. It does not prove Auth0, RLS, or end-to-end correlation. The feature remains disabled by default; a future operator execution requires all three local development settings and a real visible TTY.

```sh
NODE_ENV=development \
AEGIS_AI_ENABLED=true \
AEGIS_GROUNDED_AI_ENABLED=true \
AEGIS_OLLAMA_MODEL=qwen2.5:3b-instruct \
npm run ai:evaluate:grounded:local -w apps/api
```

Only after local source, model, health, loopback, and concurrency preflights pass does the runner request the exact human-entered phrase `RUN SIX GROUNDED EVALUATIONS`. A refusal or unavailable TTY results in zero attempts. The execution is sequential, capped at six slots, makes at most one provider request per attempted slot, never retries, and stops after transport/health failures while marking remaining slots unattempted. No inference was run as part of implementing this evaluation code.

The one-time report is reserved exclusively under `.local/evaluations/` with private directory/file permissions. It contains safe labels, classifications, booleans, fixed diagnostics, correlation UUIDs, and numeric metrics only. It excludes prompts, source text, rationales, raw model responses, credentials, and rejected output. An existing report blocks another run. A partial report is evidence of a consumed run and must not be deleted, repaired, or rerun automatically.

The API uses fixed error codes to distinguish `VALIDATION_FAILED` from `PROVIDER_UNAVAILABLE` while keeping the existing generic 503 response message. The code contains no provider stage, schema reason, prompt, or tenant information. Successful HTTP responses distinguish `SUPPORTED` and `INSUFFICIENT_EVIDENCE`; a validated abstention is counted separately from a failed provider call.

All automated evaluation tests inject deterministic providers. They do not invoke Ollama, download models, access `aegis_local`, or require a cloud service. The small synthetic set measures implementation contracts and smoke behavior, not production accuracy or reliability. Groundedness judgments require independent review and are not inferred from citation IDs.

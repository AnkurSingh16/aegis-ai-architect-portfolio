# Milestone 4 grounded evaluation

## Deterministic evaluation contract

The source-controlled suite keeps retrieval evaluation separate from grounded provider evaluation. The original `aegis-grounded-provider-v1` plan contains six fixed in-memory synthetic slots, two observations for each canonical login, billing, and guidance case type. Expected category, priority, team, action, grounding state, and source identity are engineering-reviewed labels, not human-approved ground truth. Paired observations are not independent support cases.

The scorer reports parsing, strict schema acceptance, citation validity, expected-source coverage, grounding-state agreement, category/priority/team/action agreement, human review, provider correlation, failure-stage distribution, latency, and available token counts with denominators. Null or inapplicable metrics remain `not_measured`; p95 is omitted for six observations. Citation identity and source coverage do not prove semantic entailment. Confidence is model-reported and uncalibrated.

## Observed v1 run

The private one-time report was created at `.local/evaluations/milestone-4-grounded-qwen2.5-3b-instruct.json` for commit `ca1a62aecf3ecd388afbbe4515d1dfcbe30d0105`, tree `8ddcdc5fb740100236d5a3b819080dfc107d8876`, model `qwen2.5:3b-instruct`, dataset `aegis-grounded-provider-v1`. It records 6 planned, 6 attempted, 0 successful, 6 failed, and 0 unattempted slots. All six outputs parsed as JSON, but strict schema acceptance was 0/6. All failures were `output_schema` with broad `schemaReason=invalid_output`; none were `invalid_citations`. The fixed report did not retain rejected output values, so it cannot identify the exact field-level predicate. Per-case failures were 2/2 for login, 2/2 for billing, and 2/2 for guidance.

Provider event correlation was 6/6. Median latency was 2,961 ms across six samples; p95 was not reported. Token counts were unavailable. Citation validity, expected-source coverage, grounding-state agreement, classification/priority/team/action agreement, and accepted-output human-review enforcement were not measured. The run is evidence of a schema interoperability problem for this exact model/source run, not a model-accuracy estimate. The prior Milestone 3B priority agreement of 2/6 remains a separate known limitation.

## Validation diagnostics and v2 proposal

The server parser remains authoritative. Fixed local diagnostic codes identify which existing predicate rejected an output; no rejected values, rationale, source content, citation UUIDs, or raw response are retained. The public HTTP contract remains generic. The v1 report is immutable and its one-time path remains reserved.

After this corrective release is reviewed, CI passes on the exact PR head, and the release is merged, a separately authorized v2 run may use `.local/evaluations/milestone-4.7-grounded-qwen2.5-3b-instruct-v2.json` and dataset/report version `aegis-grounded-provider-v2`. V2 accepts only clean `main` matching `origin/main`, with its tree equal to the preserved reviewed corrective branch tree and valid ancestry from the corrective base. It rejects direct evaluation on the moving feature branch. The operator must independently verify the preserved branch's exact PR head and green CI before merging. The v1 report is immutable and its one-time path remains reserved. The runner retains the same model, synthetic-only inputs, loopback Ollama, six sequential slots, one request per slot, no retries, and an interactive human confirmation. No v2 execution is authorized here.

For v2, report parsing, strict schema acceptance, and fixed validation-reason counts first. Citation and classification measures apply only to accepted outputs, and every metric keeps its numerator and denominator. Rejected outputs remain failures and are never repaired or counted as successes. The provider-level harness does not validate Auth0, membership, RLS, authenticated HTTP behavior, or semantic entailment. No six-slot result establishes production accuracy or reliability.

## Operator gate

When separately authorized after review and merge, the intended command is:

```sh
NODE_ENV=development \
AEGIS_AI_ENABLED=true \
AEGIS_GROUNDED_AI_ENABLED=true \
AEGIS_OLLAMA_MODEL=qwen2.5:3b-instruct \
npm run ai:evaluate:grounded:local -w apps/api
```

The runner must independently require a visible TTY and the exact phrase `RUN SIX GROUNDED EVALUATIONS`. Do not bypass the prompt. The existing v1 report blocks v1 re-execution; v2 uses a distinct one-time path.

Ordinary tests and CI use deterministic mocks only. They do not call Ollama, download models, access `aegis_local`, or require cloud services.

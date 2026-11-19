# Development benchmark: context assembly and output guard (local, non-qualified)

Status: **development evidence only**. Synthetic fixtures, 4 cases, 8 live requests. Not human-reviewed, not independently qualified, not a production accuracy claim. It does not use or modify the frozen six-case exploratory dataset, and it does not invoke the protected exploratory runner.

## Setup

- Model: `qwen2.5:3b-instruct`, digest `357c53fb659c5076de1d65ccb0b397446227b71a42be9d1603d46168015c9e4b` (checked against `/api/tags` before the run).
- Endpoint: `http://127.0.0.1:11434` (loopback only). No cloud or fallback provider.
- Options: `temperature 0`, `seed 1`, `num_predict 64`, `num_ctx 1024`, 30 s timeout per request, no retries, sequential, maximum 8 requests.
- Conditions per case:
  - **naive**: all passages and history, no budget.
  - **budgeted**: `assembleContext` with a 512-token budget and 64 reserved output tokens.
- Fixtures: `apps/api/scripts/fixtures/dev-context-fixtures.json` (`aegis-dev-context-assembly-v1`). Each case includes a duplicate passage and an injected instruction from an untrusted source.
- Runner: `apps/api/scripts/dev-context-benchmark.ts`. Raw output is kept outside the repository, in the session scratchpad.

## Results (8 requests, 0 errors)

| Condition | Runs | Keyword hit | Runs where the answer contained the planted sentinel | Mean model prompt tokens | Mean total latency (ms) |
|---|---|---|---|---|---|
| naive | 4 | 2/4 | 2/4 | 175 | 1105 |
| budgeted | 4 | 3/4 | 2/4 | 228 | 692 |

Notes on these numbers:
- The keyword check is a substring match and is weak. For example, `9` also matches other text. With four runs per condition, the difference between conditions is not meaningful.
- Latency is from a single short run per request on this machine. It is not a benchmark of throughput.

## Findings

1. **The prompt delimiter did not stop instruction-following.** The model echoed the planted sentinel `APPROVED-BY-SYSTEM` in 4 of 8 runs, under both conditions. Assembly-level delimiting is necessary but not sufficient. Safety must come from deterministic checks on the output.
2. **The deterministic output guard (`apps/api/src/context/output-guard.ts`) would have blocked all 4 sentinel answers.** This was computed offline from the saved records. No new inference was run for it.
3. **Approximate token counting is close but low.** `approx-bytes-div-4` underestimated the model-reported prompt count by 0–13% (for example, 233 approximate vs 247 reported on the budgeted refund prompt). Exact counts need the model's own tokenizer.

## What is implemented

- `apps/api/src/context/context-assembler.ts`: budgeted assembly with priority ordering, duplicate removal, provenance, a trace of every decision, and a deterministic overflow error.
- `apps/api/src/context/output-guard.ts`: forbidden-substring check and citation check against the assembled sources.
- `apps/api/src/retrieval/ranking-metrics.ts`: recall@K, MRR, nDCG@K, and reciprocal rank fusion, all pure functions.
- Tests: 16 for the assembler and metrics, and 4 for the guard, all deterministic.

## Not implemented or not verified

- Vector retrieval, hybrid retrieval in the database, and reranking are not connected to these metrics. No retrieval benchmark was run.
- The assembler is not yet wired into the existing grounded-analysis workflow.
- The guard does not verify that a cited claim is supported by its source. It only checks that cited identifiers were in the context.
- No larger sample, no statistical test, and no human ground truth.
- Live results apply only to this model, this digest, these options, and these four synthetic cases.

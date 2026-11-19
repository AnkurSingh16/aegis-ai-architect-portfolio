# AEGIS Enterprise AI Requirements Register

Status labels: COMPLETE, PARTIAL, MISSING, BLOCKED, NOT JUSTIFIED, UNVERIFIED.
Baseline: `origin/main` at `281926974c9b` (PR #68). Evidence is file-level, from a targeted search of `apps/api/src` on 19 Nov 2026.

This register tracks implementation status only. It does not record human approval, benchmark qualification, or production readiness.

## Technical capabilities (1–12)

| ID | Capability | Status | Repository evidence | Missing work | Next step |
|---|---|---|---|---|---|
| C1 | Context assembler engine | PARTIAL | `context/context-assembler.ts`: budgeted assembly, priority ordering, duplicate removal, provenance, trace, overflow error (16 tests incl. metrics). Dev live benchmark in `docs/DEV-CONTEXT-ASSEMBLY-BENCHMARK.md` | Approximate tokenizer only (exact counts need the model tokenizer); not wired into a workflow; no memory or summarisation | Wire into the grounded analysis path behind a flag |
| C2 | Hybrid retrieval and reranking | PARTIAL | Lexical retrieval with tenant filter: `documents/retrieval.ts`; metrics and RRF as pure functions in `retrieval/ranking-metrics.ts` (tested) | Vector retrieval and database hybrid query, reranking, metrics not yet run against a corpus, latency benchmarks | Run recall@K, MRR and nDCG on the existing retrieval fixture, lexical vs hybrid |
| C3 | GraphRAG | MISSING | None | Not evaluated. A NOT JUSTIFIED verdict needs comparative evidence against C2 first | Defer until C2 benchmarks exist |
| C4 | Self-correcting agentic RAG | MISSING | None | Query analysis, citation verification, bounded correction, abstention | Depends on C1, C2 and C5 |
| C5 | Durable agent state machine | PARTIAL | This branch: `apps/api/src/workflow/` (typed states, legal transitions, retry/backoff, failure classification, timeouts, cancellation, idempotent runner) with 20 tests | Persistence of checkpoints, restart recovery, human approval checkpoints, correlation IDs, audit storage. Current state is in-memory only | Add checkpoint storage through a reviewed, additive migration (needs approval) |
| C6 | MCP tool server | MISSING | None found | Tool schemas, permission enforcement, audit logging | Depends on C10 |
| C7 | Three-tier memory | MISSING | None found | All three tiers, retention, deletion, poisoning defences | Defer; needs privacy design decision |
| C8 | Typed multi-agent orchestration | MISSING | None found | Roles, delegation, messaging, bounded loops, approval integration | Depends on C5 and C10 |
| C9 | Trajectory evaluation and CI gates | PARTIAL | Grounded and exploratory evaluation runners and scorers under `ai/evaluation/`; CI workflows exist in `.github/` | Trajectory metrics, cost per successful task, CI regression gate verified on the exact PR head | Verify CI gate definitions before claiming any gate |
| C10 | Inter-agent security proxy | PARTIAL | `security/tool-policy-gateway.ts`: deny-by-default tool authorisation, least-privilege scope intersection, trusted-context tenant binding, argument screening (tenant, privilege, secret), approval bound to action digest, no self-approval, single-use approvals, issued single-use run ids for results. 18 adversarial tests. `context/output-guard.ts` checks answers (4 tests); live dev run showed the model echoed a planted sentinel in 4 of 8 runs | Wired to one read-only tool (`case.triage`) through `agents/tool-dispatcher.ts` with 6 tests. Not exposed on any HTTP route. Approval store is an interface only (no persistence), so no side-effecting tools are registered. Identity is passed in, not verified. No network or rate-limit controls | High priority; wire to C6 and C8 |
| C11 | Semantic cache and model routing | MISSING | Only `auth/` cache-like code (not related) | All components | Defer; measure first |
| C12 | Public architecture teardown | PARTIAL | Existing `docs/` architecture and evaluation notes | Teardown document covering all sections of the directive | Write once C1–C10 status is final |

## Director-level capabilities (L1–L6)

| ID | Capability | Status | Repository evidence | Next step |
|---|---|---|---|---|
| L1 | Reliability, SLIs and SLOs | MISSING | Metrics references in `ai/` and `auth/` only; no SLI definitions | Define SLIs from telemetry that actually exists |
| L2 | FinOps and commercial governance | MISSING | None | Requires measured token and cost data first |
| L3 | Capacity and scalability | MISSING | None | Bounded local load test only, after C5 |
| L4 | Responsible AI governance | MISSING | Evaluation provenance rules exist in `docs/` and `.claude/rules/` | Governance register once C9 provenance is verified |
| L5 | Engineering operating model | MISSING | `AGENTS.md` and `.claude/` standards | Operating model document |
| L6 | Investment and technology strategy | MISSING | None | Written only from measured evidence; no invented ROI |

## Changes in the previous slice (C5)

- `apps/api/src/workflow/execution-state.ts`: typed states and legal transitions.
- `apps/api/src/workflow/retry-policy.ts`: policy validation, deterministic backoff, fail-closed failure classification.
- `apps/api/src/workflow/execution-runner.ts`: retry driver with timeout, cancellation, audit trail, and an idempotent runner.
- `apps/api/src/workflow/execution-runner.test.ts`: 20 deterministic tests.

## Limitations

- The state machine is in-memory. A process restart loses all state, so C5 is not durable yet.
- No database migration or HTTP route uses this module.
- Discovery was a keyword search, not a complete code audit. Statuses marked MISSING mean no matching implementation was found in that search.

## Changes in the current slice (C1, C2, C10)

- `apps/api/src/context/context-assembler.ts` and tests (approximate tokenizer declared).
- `apps/api/src/retrieval/ranking-metrics.ts` and tests (recall@K, MRR, nDCG, RRF).
- `apps/api/src/context/output-guard.ts` and tests.
- `apps/api/scripts/dev-context-benchmark.ts` with synthetic fixtures `apps/api/scripts/fixtures/dev-context-fixtures.json` (non-protected, loopback Ollama, bounded to 8 requests).
- Results and limits: `docs/DEV-CONTEXT-ASSEMBLY-BENCHMARK.md`.

- `apps/api/src/security/tool-policy-gateway.ts` and 18 adversarial tests (C10).
- `apps/api/src/agents/tool-dispatcher.ts`, `default-tools.ts` and 6 tests: tool execution only through the gateway.

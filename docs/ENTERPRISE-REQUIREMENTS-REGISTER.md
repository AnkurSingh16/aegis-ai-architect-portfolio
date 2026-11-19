# AEGIS Enterprise AI Requirements Register

Status labels: COMPLETE, PARTIAL, MISSING, BLOCKED, NOT JUSTIFIED, UNVERIFIED.
Baseline: `origin/main` at `281926974c9b` (PR #68). Evidence is file-level, from a targeted search of `apps/api/src` on 19 Nov 2026.

This register tracks implementation status only. It does not record human approval, benchmark qualification, or production readiness.

## Technical capabilities (1–12)

| ID | Capability | Status | Repository evidence | Missing work | Next step |
|---|---|---|---|---|---|
| C1 | Context assembler engine | MISSING | Output-budget code exists only inside evaluation (`ai/evaluation/grounded-output-budget.ts`) | Token budgeting, prioritisation, provenance, overflow handling, integration into a workflow | Design after C5 (needs an execution path to integrate with) |
| C2 | Hybrid retrieval and reranking | PARTIAL | Lexical retrieval with tenant filter: `documents/retrieval.ts` (`ts_rank_cd` over `search_vector`); scorer in `documents/evaluation.ts` | Vector retrieval, hybrid fusion, reranking, MRR, nDCG, latency benchmarks | Add retrieval benchmark with recall@K, MRR and nDCG on the existing fixture |
| C3 | GraphRAG | MISSING | None | Not evaluated. A NOT JUSTIFIED verdict needs comparative evidence against C2 first | Defer until C2 benchmarks exist |
| C4 | Self-correcting agentic RAG | MISSING | None | Query analysis, citation verification, bounded correction, abstention | Depends on C1, C2 and C5 |
| C5 | Durable agent state machine | PARTIAL | This branch: `apps/api/src/workflow/` (typed states, legal transitions, retry/backoff, failure classification, timeouts, cancellation, idempotent runner) with 20 tests | Persistence of checkpoints, restart recovery, human approval checkpoints, correlation IDs, audit storage. Current state is in-memory only | Add checkpoint storage through a reviewed, additive migration (needs approval) |
| C6 | MCP tool server | MISSING | None found | Tool schemas, permission enforcement, audit logging | Depends on C10 |
| C7 | Three-tier memory | MISSING | None found | All three tiers, retention, deletion, poisoning defences | Defer; needs privacy design decision |
| C8 | Typed multi-agent orchestration | MISSING | None found | Roles, delegation, messaging, bounded loops, approval integration | Depends on C5 and C10 |
| C9 | Trajectory evaluation and CI gates | PARTIAL | Grounded and exploratory evaluation runners and scorers under `ai/evaluation/`; CI workflows exist in `.github/` | Trajectory metrics, cost per successful task, CI regression gate verified on the exact PR head | Verify CI gate definitions before claiming any gate |
| C10 | Inter-agent security proxy | MISSING | HTTP authentication and tenant checks exist (`auth/`). No runtime tool-authorisation layer | Deterministic tool policy engine, adversarial tests | High priority; required before C6 and C8 |
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

## Changes in this slice

- `apps/api/src/workflow/execution-state.ts`: typed states and legal transitions.
- `apps/api/src/workflow/retry-policy.ts`: policy validation, deterministic backoff, fail-closed failure classification.
- `apps/api/src/workflow/execution-runner.ts`: retry driver with timeout, cancellation, audit trail, and an idempotent runner.
- `apps/api/src/workflow/execution-runner.test.ts`: 20 deterministic tests.

## Limitations

- The state machine is in-memory. A process restart loses all state, so C5 is not durable yet.
- No database migration or HTTP route uses this module.
- Discovery was a keyword search, not a complete code audit. Statuses marked MISSING mean no matching implementation was found in that search.

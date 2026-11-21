# P4: durable multi-agent execution state

Status: **implemented and locally verified. Not production-qualified.**

Three levels, kept apart on purpose:

| Level | Meaning | P4 status |
| --- | --- | --- |
| Implemented | The schema, the transactional store, the worker harness, the telemetry and the tests exist in this branch. | Yes |
| Locally verified | The acceptance tests pass against real PostgreSQL 17 with multiple operating-system processes, and the local stack applies the migration and passes its checks. | Yes (section 9) |
| Production-qualified | Independent security review, production database operations (backup, restore, failover), a verified workload identity path for workers, the containerised worker, and load testing. | **No** (section 10) |

P4 adds no HTTP route, no tool dispatch and no external action. Execution stays disabled: nothing in the API calls the store. The store is available to code and tests only.

## 1. Architecture alignment

**C5 (workflow executions).** `aegis.workflow_executions` and `aegis.workflow_checkpoints` (migration 008 onward) are kept as they are. They model one triage workflow with approvals and retries. P4 needs delegation hops, grants, budgets and a fencing token, and none of these fit that row without changing a table C5 and the durable driver depend on. P4 therefore uses the same discipline (a row lock, a version, a lease with an owner and an expiry, append-only checkpoints) in new tables. The two models do not overlap. A later step can link a C5 execution to a P4 execution by identifier if needed. C5 is not modified.

**C8 (agent execution model, PR #77 at 08c305f).** The pure rules are ported unchanged into `apps/api/src/orchestration/` from `delegation.ts` and `types.ts` at 08c305f, together with their 33 tests. Two deliberate changes, both visible in this diff:
- `AGENT_ROLES` gains `orchestrator`, the root role and the only role that may hold a lease. C8 had no root role.
- The file headers record the origin. PR #77 is not merged. If it changes, the port must be re-done and re-tested. The P4 store depends only on the ported copy.

The P4 store does not reimplement C8 decisions. It loads the persisted state, calls `decideDelegation`, `issueGrant`, `authoriseEnvelope` and `recordDelegation`, and writes exactly what they return. The database constraints and triggers repeat the important rules as a second line of defence.

C8's open decisions (`docs/C8-ARCHITECTURE.md`, section 6), as P4 resolves them:

| # | Decision | P4 choice |
| --- | --- | --- |
| 1 | Agent identity | Each logical agent is registered against one SPIFFE workload identity (P3). The store resolves an agent only from a SPIFFE ID in `aegis.agent_registrations`. The orchestrator assigns no ids. Verification of the SVID itself is the P3 transport layer, which is not yet on this path (section 7). |
| 2 | Roles | Four roles. No registration holds a write scope. |
| 3 | Limits | Limits are per execution and stored with it. The values in tests (3, 5, 10) are illustrative, not calibrated. |
| 4 | Approval binding | Not implemented. No approval is consumed by P4, and external actions are disabled. |
| 6 | Sibling repetition | Allowed, bounded by the execution-wide budget. |
| 7 | Grant expiry | Each grant has a time bound from the database clock (`grant_ttl_seconds`, default 300). Expired open grants are revoked under the execution lock before any decision. |
| 8 | Results | The grant kind is part of the binding. A request grant cannot authorise a result (tested). |
| 9 | Concurrency | A transaction per decision, serialised by the execution row lock (section 3). |

## 2. Schema (migration 016, additive)

Five tables. Every tenant-owned table is under forced row level security on `aegis.tenant_id` for the transaction.

- **`agent_registrations`** (global catalogue). Agent id, SPIFFE ID (unique, `spiffe://aegis.local/workload/...`), role, registered scopes (a ceiling), status. Seeded with four rows: orchestrator, triage, retrieval, reviewer. The runtime role may read it and nothing else. It is under forced RLS with a read-only policy so that every `aegis` table is governed the same way.
- **`agent_executions`**. Tenant, idempotency key, principal reference (a SHA-256 digest, checked to 64 hex characters, never a raw subject), principal scopes, root agent (constrained to `orchestrator`), status, the three execution-wide ceilings (depth, delegations, steps), the counters (`delegations_issued`, `steps_taken`), attempts and maximum attempts, the fencing token, the lease (agent, instance, expiry), cancellation request and reason, and a version. Constraints keep counters inside their ceilings and keep the lease fields consistent.
- **`agent_delegations`**. One row per hop: sequence, parent sequence, depth, sender, recipient, effective scopes, chain digest, fencing token. The primary key is (execution, sequence). The chain digest is unique per execution, so the same hop cannot be recorded twice. A trigger (`check_delegation_continuity`) refuses any hop whose sender is not the holder of its parent, whose depth is not the parent's depth plus one, or that exceeds the execution's depth limit. It does this for any writer, including one that bypasses the application.
- **`agent_grants`**. One grant per exact envelope (kind, chain digest, depth, sender, recipient, action, arguments digest). Status moves only from `open` to `consumed` or to `revoked`, and a trigger makes the binding columns immutable. A partial unique index allows at most one open grant per envelope. Consumption records who consumed it and under which fencing token.
- **`agent_execution_events`**. Append-only audit, one row per decision, accepted or refused. Columns: event type and outcome from closed sets, a reason from a closed pattern, the actor agent (a registration), the worker instance, the fencing token, the delegation sequence and the grant identifier. It holds no subject, no message content, no arguments and no grant body. A trigger refuses updates and deletes.

**Least privilege.** The runtime role `aegis_app` has no `UPDATE` on `agent_registrations`, `agent_execution_events`, or on the execution's ceilings (`max_*`, `principal_*`, `root_agent`). It can update only the status, counters, lease, cancellation and version columns. Grants can be updated only in status and consumption columns. Events are insert-and-select only. `verifyRuntimeRole` now counts the five new tables and requires forced RLS on each. The storage inventory test pins them too.

**Migrations.** Migration 016 applies to a fresh database and to one previously migrated to 015. A second run applies nothing, and an edited applied migration is refused by checksum (`agent-migration.integration.test.ts`). The local stack applied it through the existing `migrate` service (`applied: 1`), and `scripts/local-stack.mjs verify` passes.

## 3. Concurrency, isolation and locking

**Isolation level.** READ COMMITTED, the PostgreSQL default. The correctness does not depend on snapshot isolation: every decision locks the execution row and re-reads it after the lock is granted.

**Locking strategy.** Each decision runs in one transaction: `SELECT ... FROM agent_executions WHERE execution_id = $1 AND tenant_id = $2 FOR UPDATE`. That lock serialises every write for one execution. It does not block other executions. The fence (lease holder, instance, fencing token, lease still live on the database clock) is checked on that locked read. The pure C8 rule then runs on the locked state, and its result is persisted in the same transaction, with the audit row. A refusal changes no state and is still audited, and it commits.

**Deadlocks.** Each transaction locks at most one execution row, and the row is locked first. The delegation trigger reads the parent hop without locking it. The foreign keys take shared locks on the parent execution, which the transaction already holds exclusively. No two transactions can wait on each other through two execution rows, so a cycle cannot form. None was observed in the concurrency tests (section 5).

**Time.** Lease expiry and grant expiry are compared with `clock_timestamp()` on the database. A worker clock is never used.

**Expected concurrency behaviour.**
- Concurrent claims: one wins, the others see the live lease and are refused (`lease_held`).
- Concurrent decisions on one execution (two branches, or two workers that carry the same fence): they run one after another. The second sees the first's counters and grants.
- Decisions on different executions: they run in parallel.
- A stale worker's write: refused by the fence, after the lock.

**Throughput.** Serialisation per execution is deliberate. Throughput per execution is the cost of one short transaction. It was not measured under load.

## 4. Crash and recovery semantics

What is guaranteed:
- **Exactly-once state transitions.** A transition is committed once, with its audit row, or not at all. A crash before COMMIT leaves no trace (checked directly in PostgreSQL). A crash after COMMIT leaves the transition in place.
- **At most one consumer per grant.** Consumption is a locked decision and a conditional update. A replay after consumption is refused as `grant_consumed`.
- **No stale commit.** A worker whose lease expired, or whose fencing token has been superseded, cannot change the execution. Its refusal is audited.
- **Budgets across workers and branches.** Counters are updated under the lock and bounded by constraints.

What is not guaranteed, and must not be claimed:
- **Exactly-once business effects.** P4 performs no external effect. If a later step performs one, a crash after the external call and before the commit can repeat that effect. The only protection is an idempotency key on the external side. P4 does not provide one, and the grant identifier is not yet passed to any external system.
- A worker that is killed mid-operation is detected only by lease expiry. Until then the execution is held. Recovery time is therefore at least the lease duration.

## 5. Verification

Commands (from `apps/api`, with `TEST_DATABASE_ADMIN_URL`, `TEST_DATABASE_URL`, `DATABASE_APP_PASSWORD` and `DATABASE_INGEST_PASSWORD` set as in CI):

```bash
npm run test:execution                 # P4 store, multi-process, migration and telemetry integration tests
npm run test:integration               # full PostgreSQL suite
npx vitest run src/orchestration       # pure C8 rules and the telemetry unit tests (no database)
```

Multi-process tests (`persistence/execution-multiprocess.integration.test.ts`). Each worker is a separate OS process running as `aegis_app`. Kills are real `SIGKILL`s at a precise point. The state is read through the owner connection.

| Scenario (request, section 4) | Test | Result |
| --- | --- | --- |
| 1. Concurrent claims of one execution | five workers claim at the same instant | one claim, four `lease_held` |
| 2. Ten concurrent consumptions of one grant | ten workers consume at the same instant | one success, nine `grant_consumed`; one consumed grant; one audited consumption |
| 3. Two branches spend the final global delegation | two workers race for the last delegation | one recorded, one `delegation_budget_exceeded`; counter 2 of 2 |
| 4. Duplicate processing of one grant issue | two workers issue the same grant | one open grant, one `duplicate_open_grant` |
| 5. Crash before commit / after commit | kill before commit; kill after the transaction returned | before: nothing persisted; after: transition persisted and audited |
| 6. Crash before a claim commits | kill before a claim commits | no lease, token 0, attempts 0 |
| 7. Worker termination, lease expiry, recovery, stale late commit | kill mid-delegation; wait for expiry; recover; the first worker commits late | recovered as token 2 (attempt 2); the late commit is `stale_fence` and audited; the killed worker's hop is absent |
| 8. Retry exhaustion across processes | two abandoned attempts, then a third claim | `retries_exhausted`, status `failed`, lease cleared |
| 9. Cancellation from another process | cancel while a worker holds the lease | the holder's next write is refused; release as `cancelled` |
| 10. Restart recovery | kill after commit, then a new process | the new process reads the same chain, counter and open grant from PostgreSQL, uses the grant once, and the second use is refused |

In-process store tests (`execution-store.integration.test.ts`, 32 tests): registration and claim rules; delegation continuity, scope escalation, cycles, depth and budget; a database trigger that refuses a discontinuous hop and a counter overshoot, even when the application is bypassed; grant single use, replay, forged principal, changed arguments, unknown fields, kind binding, duplicate open grant, scope escalation on the grant, expiry, the global step budget, and immutable grant bindings; stale fences; recovery; retry exhaustion; cancellation with and without a holder; cross-tenant isolation, cross-tenant grant replay, cross-tenant insert refused by RLS; runtime-role denials for registrations, events and ceilings; forced RLS on all five tables; and the decision hook.

Migration tests (`agent-migration.integration.test.ts`, 3 tests): fresh database, upgrade from 015, idempotence, and checksum refusal, each in a disposable database that is dropped afterwards.

Unit tests: C8 pure rules (33), telemetry instruments with an in-memory SDK meter (5).

Results at the time of writing are in the checkpoint notes and the pull request description, with local and GitHub CI results kept separate.

## 6. Observability

`persistence/execution-telemetry.ts` turns each decision into OpenTelemetry instruments, using the global meter and tracer that the existing SDK configures.

- Counters: `aegis.agent.execution.decisions` (operation, outcome, reason), `aegis.agent.lease.claims`, `aegis.agent.lease.recoveries`, `aegis.agent.fencing.conflicts`, `aegis.agent.grant.consumptions`, `aegis.agent.delegation.refusals`, `aegis.agent.retries.exhausted`.
- Gauge-like: `aegis.agent.executions.active` (an up-down counter over executions started by this process and not yet seen terminal).
- Histogram: `aegis.agent.db.operation.duration` (milliseconds, by operation, including the transaction).
- Spans: one per decision, `aegis.agent.execution.<operation>`, with the execution identifier (a random UUID reference), the outcome and the bounded reason. The three attributes are on the span allowlist.

Labels are bounded. A reason outside the known set is reported as `other`. Metrics never carry an execution identifier. No subject, principal value, message content, argument or grant body is recorded.

Limits: the instruments are verified with an in-memory SDK exporter in unit tests. They are **not** yet exported to the local Prometheus or Tempo through the running API, because the API does not call the store. The local backend check for these series is a follow-up when execution is wired in.

## 7. Identity binding (P3 to P4)

The mechanism at the database boundary: a caller presents a SPIFFE ID; the store resolves it to an active registration; only the orchestrator role may claim an execution; each write carries a fence whose agent is the registration resolved from the SPIFFE ID. An unregistered ID and a non-orchestrator ID are refused (both tested).

What is **not** done: the SPIFFE ID in the P4 tests is supplied by the test, not verified cryptographically. Verification belongs to the transport: an SVID presented over the P3 mutual TLS connection, checked with the workload API. No P4 path yet runs through a verified transport, and no containerised P4 worker exists. Until one does, P4 proves the database rules, not the identity chain. This is the largest gap in P4.

## 8. P3 follow-up: signal isolation (negative test)

`scripts/spire-acceptance.mjs`, section 3, now tests the direction the P3 document listed as untested. The SPIRE agent shares the workload's PID namespace so that it can attest by UID. The agent image has no shell, so the probe runs in a throwaway container that joins the agent's PID namespace, with the same user (root), all capabilities dropped, no new privileges, and no network. The kernel refuses the signal (`EPERM`) and the `/proc` environment read (`EACCES`), and the workload keeps serving. Verified in the stack on this branch (exit 0, see section 9). The Unix UID limits in the P3 document still apply.

## 9. Local verification record

Recorded at the time of writing (exact numbers are repeated in the checkpoint):

- Typecheck, lint: pass. Build: pass.
- Unit tests: 1070 passed (111 files).
- PostgreSQL integration tests (fresh disposable database, 001 to 016): 204 passed, 10 skipped.
- P4 orchestration integration: 45 tests (32 store, 10 multi-process, 3 migration) in the 204.
- SPIRE acceptance including the signal-isolation negative test: exit 0.
- Local stack: migration 016 applied through the `migrate` service; `local-stack.mjs verify` passes.

## 10. Remaining gaps, and what production would need

Not done, deliberately or for lack of time:
- No containerised worker. The P4 worker is a local process.
- No verified SVID path for workers (section 7).
- No HTTP route, no tool dispatch, no approval binding (C8 decision 4). External actions remain disabled.
- Telemetry is not wired into the API, so the local backends do not yet show P4 series.
- Operational behaviour under sustained load, and the cost of the per-execution lock, were not measured.
- Independent review of the schema, the grants and the RLS policies has not happened.
- The Tempo WAL question (section 11) is open, and P4 correctness does not depend on Tempo.

For production: a verified identity transport for every worker; backup, restore and failover tests for these tables; retention for `agent_execution_events`; monitoring thresholds from measured load; an independent review of the migration and the policies; and a decision on whether C5 and P4 share one execution table.

## 11. Tempo WAL block loss (P7 follow-up)

Status: **open. Not fixed, and no fix is claimed.** The detail, measurements and the rejected mitigation are in `docs/OBSERVABILITY.md` section 10. In brief: abandoned flush operations were recovered by replay in the logs examined, so they were not lost. The removed blocks were head blocks without `meta.json`, which were open at stop time. A controlled stop under load (`scripts/tempo-wal-check.mjs`) did not reproduce the loss in three runs (300, 300 and 3,000 requests), so the loss amount for those incidents is still unmeasured. Stopping the Collector first lost traces on the API side, so that ordering is not a fix.

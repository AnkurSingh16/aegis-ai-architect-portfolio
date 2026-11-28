# Cancellation: state machine, linearisation, retry, fairness and recovery

Status: Phase A of the P8 security hardening (PR #83, migrations 024 and 025). Verified by the integration tests listed in section 9 on the
commit named in the PR. Open findings F2, F3, F4 and F7 are not addressed here (see `SECURITY-TENANT-BOUNDARIES.md`, section 6).

## 1. Design decisions

- **Orchestrator owns finalisation.** Triage, retrieval and reviewer can refuse a post-cancellation request but cannot change execution
  state. Nothing is granted to them by this work.
- **Retry state lives on `aegis.agent_executions`** (migration 025), not in a separate table. A cancellation is one-to-one with its
  execution, the composite key `(tenant_id, execution_id)` already exists, and no new policy or join is needed. Five columns are added:
  `cancel_requested_at`, `cancellation_attempts`, `cancellation_next_attempt_at`, `cancellation_last_attempt_at`,
  `cancellation_failure_class`. There is no free-text failure message: the class is one of `transient`, `systemic`, `execution_refused`.
- **Database time** sets every persisted schedule (`clock_timestamp()` in triggers and functions). Application clocks are not used for
  eligibility.
- **Only the orchestrator writes retry columns** (`GRANT UPDATE` on four of them). The gateway gets no new privilege: a trigger sets
  `cancel_requested_at` and the first eligibility time when `cancel_requested` first becomes true.

## 2. State model

```
                      gateway commits cancel_requested (lease live)
   [running, not requested] ---------------------------------------> [requested, due now]
                                                                          |  orchestrator finalises (commit)
                                       failure recorded (own tx)          v
                    [requested, scheduled] <-----------------------  [requested, due]  ---> [cancelled]  (terminal)
                    next_attempt_at in future                              ^
                                       due again -------------------------+
```

- A cancellation is **pending** while `cancel_requested` is true and status is not `succeeded`, `failed` or `cancelled`.
- A pending cancellation is **due** when `cancellation_next_attempt_at <= clock_timestamp()`.
- Finalisation sets `status = 'cancelled'`, clears the lease, increments the fencing token, revokes open grants, writes one `cancelled` audit
  event, and clears `cancellation_next_attempt_at`. Attempt history (count, last attempt, failure class) is kept.
- Gateway requests with **no live lease** set `cancelled` directly in the gateway transaction. They never enter the reconciler.

## 3. Linearisation points

| Event | Commits | Serialised by |
|---|---|---|
| Cancellation request (lease held) | `cancel_requested = true` (gateway) | `FOR UPDATE` on the execution row |
| Finalisation | `status = cancelled`, grants revoked, audit (orchestrator) | `FOR UPDATE` on the execution row, after revalidating terminal state |
| Completion (holder release `succeeded`) | `status = succeeded` | `FOR UPDATE`; refused if `cancel_requested` is already committed |
| Request-grant consumption (any path) | `grant.status = consumed` | Trigger takes `FOR SHARE` on the execution row (migration 025), so it conflicts with every cancellation write |
| Failure recording | retry columns (own transaction) | `FOR UPDATE`; applies only while the row is still pending |

Whichever write commits first on the execution row wins. The loser re-evaluates the committed row:

- Cancellation first, then completion: completion is refused as `cancel_requested`. The holder's lease remains until the reconciler
  finalises. (Before Phase A, this refusal did not hold for `succeeded`; see section 8.)
- Completion first, then cancellation: the cancellation sees a terminal execution and changes nothing.
- Cancellation first, then consumption: the consumption is refused with SQLSTATE 42501.
- Consumption first, then cancellation: the consumed grant stays consumed; the cancellation finalises and revokes only open grants.

## 4. Reconciliation cycle

1. Discover at most `limit` (1 to 50) due pending cancellations, ordered by `cancellation_next_attempt_at, execution_id`.
2. For each candidate, in its own transaction: `SET LOCAL lock_timeout` (default 2 s) and `statement_timeout` (default 5 s), then
   `finaliseCancellation` under the row lock.
3. On a finalisation error, classify it:
   - **systemic** (SQLSTATE 42501, 42883, 42P01, 42703, 28000, 28P01, 3D000): not recorded against the row. The cycle halts.
   - **transient** (anything else, including lock and statement timeouts): recorded.
   - **execution_refused** (the execution is not visible in its tenant): recorded.
4. Record the failure in a **separate transaction**. The update applies only while the row is still pending, so it cannot overwrite a
   terminal execution, and a stale reconciler cannot restore retry state for a finished cancellation.
   - If the record itself hits a lock or statement timeout, the row is **deferred**: it stays due and the cycle continues.
   - If the record fails for any other reason, the outcome is **unrecorded** and the cycle halts. The row stays due, so the next cycle
     retries it.
5. The runtime loop runs every `AEGIS_DISPATCH_INTERVAL_MS` (default 200 ms). A halted cycle or an error doubles the delay, capped at 30 s.

## 5. Retry policy

| Parameter | Value | Where |
|---|---|---|
| First backoff | 1 s | `recordCancellationFailure` (SQL) |
| Backoff growth | doubles per stored attempt | SQL: `power(2, LEAST(attempts, 6))` |
| Maximum backoff | 60 s | SQL: `LEAST(interval '60 seconds', …)` |
| Stored attempts | saturate at 1000 | SQL `LEAST(attempts + 1, 1000)` and table CHECK |
| Discovery batch | 10 per cycle (runtime), 50 maximum | runtime; SQL `LEAST(p_limit, 50)` |
| Lock timeout | 2 s | `lockTimeoutMs` (100 ms to 30 s) |
| Statement timeout | 5 s | `statementTimeoutMs` (100 ms to 60 s) |
| Idle cycle delay | 200 ms | `AEGIS_DISPATCH_INTERVAL_MS` |
| Halted or failed cycle delay | 1 s doubling to 30 s | runtime |

**Retry exhaustion.** There is none. A failing cancellation is never abandoned: it is retried every 60 s indefinitely. This is deliberate,
because a cancellation the user requested must not be silently dropped. The consequence is that a permanently failing cancellation costs
one attempt per minute, and it stays visible in the backlog figures. **There is no automatic dead-letter and no operator action in this
branch.** Adding one would need a decision about who may close a cancellation that cannot be finalised. Until then, operators see it in the
logs and the backlog, and the database holds the row.

## 6. Fairness and starvation

Assumptions required for the guarantees below:
- the orchestrator process runs, and its reconciliation loop is not blocked by another part of the process;
- PostgreSQL responds, and lock holders eventually commit or roll back;
- no more than one cycle at a time per orchestrator instance (the loop is sequential).

Analysis:

- **Finite queue, poisoned rows.** A failed row moves to `now + backoff`, so it leaves the due set for at least 1 s. With `P` poisoned
  rows and batch `k`, after at most `ceil(P / k)` cycles every initially poisoned row has been attempted once and is no longer due. A healthy
  row that was due at the start is then processed in the next cycle. Test A6.2 checks this bound with `P = 5`, `k = 2`.
- **Locked execution.** A row blocked by a long lock times out after `lockTimeoutMs` and is deferred without halting. Each cycle pays at most
  `k × lockTimeoutMs` in lock waits. Test A6.7 checks that a locked row does not stop an unrelated one.
- **Continuously arriving work.** No bounded completion is claimed. If new cancellations arrive faster than `k` per cycle, a healthy row may
  wait indefinitely. The batch and cycle interval are the capacity levers.
- **Long-held lock on one execution** (for example a stuck holder transaction). Its cancellation is deferred on every cycle until the lock
  is released. It does not block others, but it is never finalised while the lock is held. Nothing in this branch kills an idle-in-
  transaction session.
- **Several orchestrator instances.** Discovery takes no lock, so instances may pick the same candidate. The row lock serialises the
  finalisations, and the loser sees a terminal execution and returns `skipped`. Test A5.4 verifies one `cancelled` event and no revival.

## 7. Startup validation

`verifyCancellationAuthority` runs before the orchestrator starts its loops, through the connection it will use. It checks the catalog and
effective privileges:

- each required function exists;
- definer rights are set where required, and `search_path` is pinned to `pg_catalog, aegis`;
- the owner is a superuser or has BYPASSRLS (otherwise discovery silently returns nothing);
- PUBLIC holds no EXECUTE, no role other than the owner and the intended caller holds EXECUTE, and the intended caller does;
- the runtime identity is not a superuser, not BYPASSRLS, and maps to the orchestrator in the role table.

On failure, the orchestrator logs `cancellation_authority_refused` with the failed check names only, and exits. Check names are the only
text it logs; no catalog values, identifiers or credentials.

**Narrower owner.** The owner check accepts a superuser owner, which is the local default. A dedicated NOLOGIN owner with only the table
privileges the functions need would remove that. It is not implemented: changing the owner of existing functions and provisioning that
role is a role-redesign decision for a separate approval.

## 8. Defects found and fixed in this phase

- **Completion after a cancellation request was not refused for `succeeded`.** `release` passed `completesCancellation = true` for every
  call, so a holder could still mark an execution `succeeded` after `cancel_requested` committed. The stage trigger blocked only the
  `completed` stage, so `insufficient_evidence` was not covered. Fixed in the store: only `cancelled` releases bypass the refusal.
- **Request-grant consumption trigger read without a lock** (migration 023 and 024). A consumption outside `lockAndFence` could race a
  cancellation. Fixed in migration 025 with `FOR SHARE` on the execution row.
- **Starvation.** The 024 discovery ordered by `updated_at`, so a failing row stayed at the front. Fixed by next-attempt ordering and
  backoff (migration 025).
- **Lock waits during failure recording** would have halted the whole cycle. Now they are deferred (section 4).

## 9. Test evidence (PostgreSQL integration; run in CI on the final commit)

- `cancellation-reconciliation.integration.test.ts`: tests A to N from Phase P8 remain. Tests use the production reconciler.
- `cancellation-concurrency.integration.test.ts`: A5.1 to A5.4 (two-session contention observed in `pg_stat_activity`, both orderings,
  competing reconcilers); A6.1 to A6.11 (poisoned-first, batch saturation, backoff and saturation at 1000, recovery, interruption between
  finalisation and recording, restart with a fresh pool, lock timeout not blocking unrelated rows, cross-tenant isolation, participant
  refusal, backlog visibility, idempotency).
- `cancellation-authority.integration.test.ts`: fresh install to 025 and validation passes; upgrade from 024 with a persisted pending
  cancellation; each negative configuration (PUBLIC, unexpected grant, unpinned search_path, non-BYPASSRLS owner, missing function, superuser
  runtime identity) refused.

Tests inject faults only through `ReconcileOptions.injectFault`, a test seam the runtime never passes. Nothing is environment-controlled.
Backoff is exercised with a persisted, test-only timestamp rather than long waits.

**Restart.** A6.6 uses a fresh connection pool with no in-memory state. It is a simulated restart. A real process kill is not tested here.

## 10. Telemetry

Logged by the orchestrator, counts and names only:

- `cancellation_reconciled`: per-cycle summary (candidates, applied, skipped, refused, transient, deferred, systemic, unrecorded, halted);
- `cancellation_backlog` (every 30 s): pending, overdue, failing, max attempts, oldest request age (seconds);
- `cancellation_error`, `cancellation_authority_refused`.

No identifiers or messages are logged. The OpenTelemetry and Tempo/Loki stack is stopped on this machine, so these signals are not yet
exported anywhere.

## 11. Residual risks and unsupported guarantees

- No bounded completion under unlimited arrivals, permanent database unavailability, or indefinite lock contention (section 6).
- No dead-letter, no retry exhaustion, no automatic or operator closure of a permanently failing cancellation (section 5).
- The owner of the privileged functions must be a superuser or BYPASSRLS. Validated, not narrowed (section 7).
- Discovery and backlog are cross-tenant by design, returning identifiers or aggregates only to the orchestrator.
- An idle-in-transaction holder can keep one cancellation deferred indefinitely (section 6).
- Race coverage is two explicit sessions with observed contention, not a randomised or load-based race search.
- Phase A has not been independently reviewed by a human. The source-first review is performed by the implementing agent, and this document
  does not treat it as independent.
- F2, F3, F4 and F7 remain open and are not accepted by this document.

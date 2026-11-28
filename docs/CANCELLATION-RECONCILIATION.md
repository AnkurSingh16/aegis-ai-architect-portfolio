# Cancellation: request, finalisation, retry, fairness and recovery

Status: Phase A and A.1 of the P8 security hardening (PR #83, migrations 024 and 025). The implementation and tests are described here as
they are in the branch. Results are reported per commit in the PR, not in this document. Open findings F2, F3, F4 and F7 are not addressed
here (see `SECURITY-TENANT-BOUNDARIES.md`, section 6).

## 1. Design decisions

- **Gateway records a request; the orchestrator finalises.** The gateway's role may set `cancel_requested` and nothing else on an execution
  (migration 018 grant and its `WITH CHECK (cancel_requested)` policy). It never sets a terminal status, revokes grants or releases a lease.
  Finalisation happens only in the orchestrator, with or without a live lease.
- **Participants cannot finalise.** Triage, retrieval and reviewer can refuse a post-cancellation request but cannot change execution state.
- **Retry state lives on `aegis.agent_executions`** (migration 025). The composite key `(tenant_id, execution_id)` already exists. Five columns:
  `cancel_requested_at`, `cancellation_attempts`, `cancellation_next_attempt_at`, `cancellation_last_attempt_at`,
  `cancellation_failure_class`. The failure class is one of `transient`, `systemic`, `execution_refused`. There is no free-text message.
- **Database time** sets every persisted schedule.
- **Only the orchestrator writes retry columns** (`GRANT UPDATE` on four of them). A trigger sets `cancel_requested_at` and the first
  eligibility time when `cancel_requested` first becomes true, so the gateway needs no privilege for it.

## 2. Gateway request

`requestCancellation` (production route `POST .../investigations/:id/cancel`) does the following:

1. Verifies the membership role and loads the execution. A row that belongs to another principal, or to another tenant, returns
   `not_found` and changes nothing.
2. If the execution is already terminal, returns `{ accepted: false, state: 'terminal' }`.
3. Runs one conditional UPDATE, bound to the verified principal, the tenant, `NOT cancel_requested`, and a non-terminal status. It sets
   the flag and the reason only.
4. If the UPDATE changed a row, writes one `cancel_requested` event (reason `requested`) and returns
   `{ accepted: true, state: 'cancel_requested' }`.
5. If the UPDATE changed nothing, re-reads the committed row. Terminal means `{ accepted: false, state: 'terminal' }`; otherwise
   `{ accepted: true, state: 'already_requested' }`. No second event is written.

The response distinguishes **requested** (`cancel_requested`, `already_requested`) from **finalised** (the orchestrator later moves the
execution to `cancelled`). The browser text should say so; see section 10.

Defect fixed in this phase. The store method `requestCancel` used to change status and revoke grants directly when no lease was held. The
gateway role has no such privilege, so the request failed with SQLSTATE 42501 (`permission denied for table agent_executions`). The
production route never reached that branch, because it uses `requestCancellation`, but the store method was the test harness's
"gateway". The store method now has the same flag-only semantics.

## 3. Linearisation points

| Event | Commits | Serialised by |
|---|---|---|
| Gateway request | `cancel_requested = true` | `UPDATE` row lock (conditional on the row's state at lock time) |
| Finalisation | `status = cancelled`, open grants revoked, audit (orchestrator) | `FOR UPDATE` on the execution row, after revalidating terminal state |
| Holder completion (`release` with `succeeded`, `failed` or `pending`) | status | `FOR UPDATE`; refused as `cancel_requested` once the request is committed |
| Request-grant consumption (any path) | `grant.status = consumed` | Trigger takes `FOR SHARE` on the execution row (migration 025), so it conflicts with every cancellation write |
| Failure recording | retry columns (own transaction) | `FOR UPDATE` on the row, guarded by the scheduling generation (section 5) |

The execution row is the single serialisation point for cancellation. The trigger's `FOR SHARE` makes direct SQL consumption wait for it.

**Lock order.** The production receive path takes the execution row lock first, then updates grants, which is the same order as
finalisation. Direct SQL that updates a grant before the execution can invert that order. This was reproduced in test A5.5: the two
sessions deadlock, PostgreSQL aborts one with SQLSTATE 40P01, and reconciliation recovers. The fix is to keep the order consistent
everywhere, not to widen privileges. Direct SQL is an administrative path only.

## 4. Reconciliation cycle

1. **Discover** at most `limit` (1 to 50) due, pending cancellations, ordered by `cancellation_next_attempt_at, execution_id`, with
   `FOR UPDATE SKIP LOCKED` (migration 025). An execution that another transaction holds at discovery time is skipped, not returned.
2. For each candidate, in its own transaction: `SET LOCAL lock_timeout` (default 2 s) and `statement_timeout` (default 5 s), then
   `finaliseCancellation` under the row lock.
3. On a finalisation error, classify it:
   - **systemic** (SQLSTATE 42501, 42883, 42P01, 42703, 28000, 28P01, 3D000): not recorded against the row; the cycle halts.
   - **transient** (anything else): recorded.
   - **execution_refused** (the execution is not visible in its tenant): recorded.
4. Record the failure in a **separate transaction**, with the same lock and statement timeouts, guarded by the discovered generation.
   - A lock or statement timeout while recording is **deferred**: the row stays due, and the cycle continues.
   - Any other recording failure is **unrecorded** and halts the cycle, so the next cycle retries the same row.
   - A stale or terminal row is **skipped**.
5. The runtime loop runs every `AEGIS_DISPATCH_INTERVAL_MS` (default 200 ms). A halted cycle or an error doubles the delay, from 1 s up to 30 s.

## 5. Retry policy and concurrent retry semantics

| Parameter | Value | Where |
|---|---|---|
| First backoff | 1 s | SQL, in `recordCancellationFailure` |
| Growth | doubles per stored attempt | SQL: `power(2, LEAST(attempts, 6))` |
| Maximum backoff | 60 s | SQL: `LEAST(interval '60 seconds', …)` |
| Stored attempts | saturate at 1000 | SQL `LEAST(attempts + 1, 1000)` and table CHECK |
| Discovery batch | 10 per cycle (runtime), 50 maximum | runtime; SQL `LEAST(p_limit, 50)` |
| Lock timeout | 2 s (100 ms to 30 s) | `lockTimeoutMs` |
| Statement timeout | 5 s (100 ms to 60 s) | `statementTimeoutMs` |
| Idle cycle delay | 200 ms | `AEGIS_DISPATCH_INTERVAL_MS` |
| Halted or failed cycle delay | 1 s doubling to 30 s | runtime |

**Scheduling generation.** The generation of a pending cancellation is its `cancellation_attempts` value at discovery. A failure is
recorded only if the stored value still equals the generation the reconciler discovered. The update then increments the value and
reschedules. This gives:

- **Two reconcilers failing the same candidate:** the first records attempt 1; the second, holding generation 0, is skipped. Attempts
  advance by one, not two.
- **A stale failure after a newer schedule:** skipped. The newer `next_attempt_at` is not moved.
- **A stale failure after a successful finalisation:** skipped, because the row is terminal and the update also requires pending state.
- **Saturation:** the counter stops at 1000 and the interval stays at 60 s.

**Retry exhaustion.** There is none. A failing cancellation is retried every 60 s indefinitely. This is deliberate: a cancellation the user
requested must not be dropped silently. It is visible in the backlog counts. **There is no automatic dead-letter and no operator action in
this branch.** Adding one would need a decision about who may close a cancellation that cannot be finalised.

**Metadata on success.** Finalisation sets the status to `cancelled`, clears the lease, increments the fencing token, and sets
`cancellation_next_attempt_at` to NULL. It retains `cancellation_attempts`, `cancellation_last_attempt_at` and
`cancellation_failure_class` as historical evidence of the attempts that preceded success. `cancel_requested_at` is also retained.

**Restart.** The schedule and the counters are in the database. A restarted orchestrator resumes from them with no in-memory state.

## 6. Fairness, starvation and lock contention

Assumptions for the guarantees below: the orchestrator's loop is sequential per instance; PostgreSQL responds; lock holders eventually
commit or roll back, or are terminated by an operator. Under these, the following hold.

- **One execution indefinitely locked.** Discovery skips it, so it is neither selected nor deferred. Healthy cancellations proceed. The
  locked execution is not finalised while the lock is held. Test A6.9.
- **Exactly one full batch indefinitely locked** (10 locked, batch 10). Discovery skips all 10, so healthy work in the same cycle
  proceeds. Test A6.7.
- **More than one batch indefinitely locked** (25 locked, batch 10). Discovery still skips all 25 and returns the healthy rows. Healthy
  work proceeds across several cycles while the locks are held. Test A6.8. After release, the previously locked rows are discovered and
  finalised within a bounded number of cycles.
- **Locks that begin after discovery.** A row locked between discovery and finalisation waits up to `lockTimeoutMs`, and its recording
  also waits. Its outcome is deferred and it stays due. Each such row costs at most one lock timeout per cycle. Locks acquired at that
  moment are the only remaining case where the batch can pay a cost; the cost is bounded.
- **Multiple orchestrator instances.** Discovery is lock-aware and takes no lock that persists. Two instances may pick the same candidate
  when neither sees it locked; the row lock serialises the finalisations, and the loser sees a terminal execution and returns `skipped`.
  Test A5.4 verifies one `cancelled` event.
- **Database temporarily unavailable.** The cycle throws. The runtime backs off to 30 s. Nothing is recorded or lost, because every
  schedule is in the database and nothing is held in memory.
- **New cancellations keep arriving.** No bounded completion is claimed. If arrivals exceed the batch rate, a healthy row can wait
  indefinitely. The lever is the batch size and the cycle rate, not a guarantee.
- **A holder that never commits** (an idle-in-transaction session). Its execution is never finalised while the lock is held. Nothing in this
  branch terminates it. This is a deployment concern, to be handled by a database idle-transaction timeout.

## 7. Startup authority validation

`verifyCancellationAuthority` runs before the orchestrator starts its loops, through the connection it will use. It checks, by name:

- each required function exists **with the exact signature**;
- definer rights are set where required, and `search_path` is pinned to `pg_catalog, aegis`;
- the owner is a superuser or has BYPASSRLS, **and** has `SELECT` on `agent_executions` (BYPASSRLS alone is not proof of access);
- PUBLIC holds no EXECUTE; no role other than the owner and the intended caller holds EXECUTE; the intended caller does;
- both cancellation triggers exist, are attached to the intended relation and function, and are enabled (`tgenabled = 'O'`);
- the runtime identity is not a superuser, not BYPASSRLS, maps to the orchestrator in the role table, holds **no role memberships** (so no
  inherited privilege and no role assumption), and can execute the discovery and backlog functions.

On failure, the orchestrator logs `cancellation_authority_refused` with the failed check names only, then exits. No catalog values,
identifiers or credentials are logged.

**Owner.** The owner must be a superuser or BYPASSRLS, because the functions read `agent_executions` across tenants. Narrowing it to a
dedicated NOLOGIN owner would need the table privileges granted to that role, which is a role-provisioning change. It is **not
implemented**. It is an unresolved deployment limitation, retained with its validation.

**Schema resolution.** The functions pin their search path. A schema-creation privilege for untrusted roles on `aegis` or on
`pg_catalog`-shadowing schemas is not validated in this phase. This is recorded as a residual.

## 8. Defects found and fixed in Phase A and A.1

- **Gateway cancellation without a lease failed with SQLSTATE 42501** (section 2). Fixed: flag-only request, orchestrator-owned finalisation.
- **Completion after a committed request was accepted for `succeeded`.** The store's `release` bypassed the refusal for every status. Fixed:
  only `cancelled` releases bypass it. Regression covered by test A5.1.
- **Request-grant consumption read without a lock** (migrations 023 and 024). Fixed in 025 with `FOR SHARE`.
- **Starvation by a locked batch.** Discovery returned the locked rows first and they were deferred repeatedly. Fixed in 025 with
  `SKIP LOCKED` discovery.
- **Lock order inversion** between direct SQL grant updates and the trigger (section 3). Reproduced in A5.5 as an aborted transaction
  (SQLSTATE 40P01) with recovery. No privilege was widened.
- **Stale failure updates** could advance a newer schedule. Fixed by the generation guard.

## 9. Migration handling

Migrations 001 to 024 are unchanged. Migration 025 is **edited in place within the unmerged draft**. The decision and its basis:

- 025 was pushed to the draft PR but has not been applied to any persistent database. `aegis_local` has not been migrated, and CI uses
  disposable databases that are created and dropped for each run.
- The change adds `FOR UPDATE SKIP LOCKED` to a function created in 025 and adds no new object.

If 025 is ever applied to a persistent database, any further change must be a new additive migration (026 or later), and 025 must not be
rewritten. Fresh installation, upgrade from 024, and upgrade from the previous draft 025 are tested as described in section 11.

## 10. Browser contract

The web panel says "Cancellation requested. It takes effect at the next step." That describes the request, not the finalisation. The text
is changed to say the cancellation is requested and that the orchestrator will finalise it. Terminal stage `cancelled` is shown only
after finalisation.

## 11. Test evidence

PostgreSQL integration tests, run in CI on the final commit (counts are in the PR, not repeated here):

- `cancellation-concurrency.integration.test.ts`
  - the orchestrator and gateway runtime identities pass validation, and the gateway identity is refused as orchestrator;
  - A5.1 cancellation wins: a completion waits on the gateway's PID and is refused as `cancel_requested`;
  - A5.2 completion wins: the gateway request waits on the completion's PID and reports `terminal`;
  - A5.3a consumption first (trigger-level, direct SQL): the gateway request waits on the consumer's PID and is finalised afterwards;
  - A5.3b cancellation first: consumption is refused with 42501, the grant stays open until reconciliation, then is revoked;
  - A5.4 competing reconcilers: one cancelled event;
  - A5.5 opposing lock order: one session aborted with 40P01, and recovery;
  - A6.1 to A6.14: poisoned-first, batch saturation, backoff and saturation, recovery, interruption between finalisation and recording,
    restart with a fresh pool, full-batch and multi-batch lock-aware fairness, a locked execution not blocking others, generation guard,
    participant refusal, cross-tenant isolation, backlog visibility;
  - connection lifecycle: a held lock does not hold pool connections.
- `cancellation-authority.integration.test.ts`
  - fresh install to 025 and the validation passes;
  - upgrade from 024 with a persisted pending cancellation;
  - negative cases: PUBLIC, unexpected grant, unpinned search path, non-BYPASSRLS owner, BYPASSRLS owner without table privilege, missing
    function, overloaded signature, dropped trigger, disabled trigger, superuser runtime identity, runtime role membership.
- `investigation/gateway.test.ts`: request, idempotent repeat, lost race to terminal, principal refusal, finished executions.

Tests inject faults only through `ReconcileOptions.injectFault`, a test seam the runtime never passes. Backoff is exercised with a
persisted, test-only timestamp, not waiting.

## 12. Residual risks and unsupported guarantees

- **Not implemented in this phase:** a production-path grant-consumption race through a participant login with `receiveMessage` and the
  consume-decision path (section 11 covers the trigger and direct SQL only); a real process-kill crash recovery matrix (restart is
  simulated with a fresh pool); a two-process reconciler test.
- No bounded completion under unlimited arrivals, permanent database unavailability, or permanently held locks (section 6).
- No dead-letter, no retry exhaustion, no operator closure of a cancellation that cannot be finalised (section 5).
- The owner of the privileged functions must be a superuser or BYPASSRLS. Validated, not narrowed (section 7).
- Schema-creation privileges for untrusted roles are not validated (section 7).
- An idle-in-transaction holder can keep one execution unfinalised indefinitely (section 6).
- Discovery and backlog are cross-tenant by design, returning identifiers or aggregates only to the orchestrator.
- The concurrency tests use explicit barriers and observed PIDs. They are not a randomised race search.
- The review of this change is the implementing agent's source-first pass. It is not an independent or human review, and it is not a
  security qualification.
- F2, F3, F4 and F7 remain open and are not accepted by this document.

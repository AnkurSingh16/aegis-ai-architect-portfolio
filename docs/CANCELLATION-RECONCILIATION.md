# Cancellation: request, finalisation, retry, fairness and recovery

Status: Phase A, A.1, A.2 and A.3 of the P8 security hardening (PR #83, migrations 024, 025 and 026). The implementation and tests are described here as
they are in the branch. Results are reported per commit in the PR, not in this document. Open findings F2, F3, F4 and F7 are not addressed
here (see `SECURITY-TENANT-BOUNDARIES.md`, section 6).

## 1. Design decisions

- **Gateway records a request; the orchestrator finalises.** The gateway's role may set `cancel_requested` and nothing else on an execution
  (migration 018 grant and its `WITH CHECK (cancel_requested)` policy). It never sets a terminal status, revokes grants or releases a lease.
  Finalisation happens only in the orchestrator, with or without a live lease.
- **Participants cannot finalise.** Triage, retrieval and reviewer can refuse a post-cancellation request but cannot change execution state.
- **Retry state lives on `aegis.agent_executions`** (migrations 025 and 026). The composite key `(tenant_id, execution_id)` already exists.
  Six columns: `cancel_requested_at`, `cancellation_attempts`, `cancellation_next_attempt_at`, `cancellation_last_attempt_at`,
  `cancellation_failure_class`, and `cancellation_generation` (bigint, added by 026). The failure class is one of `transient`, `systemic`,
  `execution_refused`. There is no free-text message.
- **Database time** sets every persisted schedule.
- **Only the orchestrator writes retry columns** (`GRANT UPDATE` on five of them, including the generation). A trigger sets `cancel_requested_at` and the first
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

**Public response contract** (`POST .../investigations/:executionId/cancel`, HTTP 200 on a decision):

| Situation | Body |
|---|---|
| First request by the originating principal | `{ "accepted": true, "state": "cancel_requested" }` |
| Repeat while the request stands | `{ "accepted": true, "state": "already_requested" }` (no second event) |
| Execution already finished (including after a cancellation was finalised, or a completion that committed first) | `{ "accepted": false, "state": "terminal" }` |
| Another principal, another tenant, or an unknown execution | HTTP 404 with an identical body in each case |

`state` is the additive field of Phase A.1. It is the gateway's own result, and no consumer in this repository read the earlier
`{ accepted: true }`-only body. The principal and tenant are always taken from the verified token and the route; the body carries only
`reason`. The response distinguishes **requested** (`cancel_requested`, `already_requested`) from **finalised** (the orchestrator later
moves the execution to `cancelled`). The browser text should say so; see section 10.

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
| Failure recording | retry columns and generation (own transaction) | `FOR UPDATE` on the row, guarded by the scheduling generation (section 5) |

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
| Stored attempts | saturate at 1000 (operational history; drives the backoff only) | SQL `LEAST(attempts + 1, 1000)` and table CHECK |
| Scheduling generation | bigint, never capped; advances on every schedule write | `cancellation_generation` (migration 026); carried as a decimal string in TypeScript |
| Discovery batch | 10 per cycle (runtime), 50 maximum | runtime; SQL `LEAST(p_limit, 50)` |
| Lock timeout | 2 s (100 ms to 30 s) | `lockTimeoutMs` |
| Statement timeout | 5 s (100 ms to 60 s) | `statementTimeoutMs` |
| Idle cycle delay | 200 ms | `AEGIS_DISPATCH_INTERVAL_MS` |
| Halted or failed cycle delay | 1 s doubling to 30 s | runtime |

**Scheduling generation (migration 026).** Each pending cancellation carries `cancellation_generation`, a bigint that starts at 0 and
increments on every schedule write. It is separate from `cancellation_attempts`, which saturates at 1000 and only sets the backoff. A
failure is recorded only while the stored generation still equals the value the reconciler read at discovery. The update then increments
the generation, increments the (saturating) attempt count, and reschedules. Migration 025 used the attempt count as the guard, which
could not distinguish writers once it saturated; that defect is corrected here. The semantics:

- **Duplicate failures from one discovery generation:** the first records and advances the generation; the second is refused as stale
  and changes nothing (test A6.10).
- **Stale failure after a newer schedule:** refused, so the newer `next_attempt_at` is not moved (A6.10).
- **Concurrent failures at attempt 999:** both reconcilers hold generation 5; the row lock serialises them, the second re-evaluates the
  guard and is refused. Attempts reach 1000 once (A6.11).
- **Concurrent failures at saturated attempt 1000:** both hold generation 6; one records, the count stays at 1000, and the generation
  advances once (A6.11).
- **Failure after a successful finalisation:** refused, because the row is terminal (A6.10).
- **Backoff after saturation:** the interval stays at the 60 s cap (A6.11), and the cancellation stays due and visible in the backlog.
- **Generation format:** accepted only as a canonical decimal of at most 18 digits. Anything else is refused before the database is
  reached, so no value is converted to a JavaScript number (A6.11b).

Retry metadata history is preserved: attempts and last-attempt time are kept after success, as before.

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
  when neither sees it locked. Test A5.4 holds both reconcilers at a gate after discovery, then holds the row lock from a third session, so
  both finalisations genuinely queue on the same row. After release, exactly one applies the transition and the other reports `skipped`.
  The test asserts one `cancelled` event, no retry metadata left active, and no revival on a later cycle. A test-only gate
  (`ReconcileOptions.injectFault`, now awaitable) provides the deterministic point; the runtime never passes it.
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
- both cancellation triggers exist, are attached to the intended relation and function, are enabled (`tgenabled = 'O'`), and are
  row-level `BEFORE UPDATE` triggers (their event configuration is checked, not only their name);
- the owner has UPDATE privilege on `agent_executions` (required by the `FOR UPDATE` discovery lock), SELECT on
  `agent_database_roles` (required by the orchestrator-only check), and schema usage on `aegis`;
- the runtime identity has schema usage on `aegis` and SELECT on `agent_database_roles`;
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

Defects fixed in Phase A.2:

- **CI coverage gate failed** (statements 59.93%, threshold 60%). `cancellation.ts` had no unit tests. Fixed with focused unit tests of
  every outcome class, halting rule, bound and backlog mapping, and of the authority validator (61.37% statements after the change). No
  threshold, exclusion or collection setting was changed.
- **Test A5.4 contradicted the algorithm.** It expected a reconciler to block on a row held by a third session, but migration 025 uses
  `SKIP LOCKED`, so a reconciler never queues during discovery. Corrected as described in section 4.
- **Saturating scheduling guard.** The guard used the saturating attempt count; see section 5. Fixed by migration 026.
- **Test cleanup could hang.** Started operations were awaited before the sessions holding their locks were released. Cleanup now aborts
  barriers, grants a grace period, terminates the test's own sessions if operations are still queued, settles operations within a bound,
  and releases each client once. A negative test interrupts a contention scenario and checks that the blocker is gone and the pool is
  available.
- **Deadlock test assumed one victim and a successful second operation.** A5.5 now accepts either victim, but only the outcomes that the
  committed cancellation makes possible: if the finalisation is the victim, the consumer is refused with 42501; if the consumer is the
  victim, the finalisation completes. Exactly one 40P01 is required. The consuming side is the participant login (`aegis_triage`), not
  the administrative pool. Migration 018 grants that role `UPDATE(status, consumed_at, consumed_by_agent, consumed_by_fencing_token,
  revoked_at)` on `agent_grants` and a consume policy, so direct SQL consumption is a participant-reachable path, not only an
  administrative one. It is a SQL path, not the `receiveMessage` path (section 11 covers that path separately).

## 9. Migration handling

Migrations 001 to 024 are unchanged. Migration 025 is **not** amended in this phase. Migration 026 is additive and applies after it.

**Supported upgrade paths (tested):** fresh installation through 026; upgrade from 024 (applies 025 and 026, with a pending cancellation
scheduled for immediate eligibility); upgrade from the 025 baseline with retry state (attempts, schedule and last-attempt time are kept,
the failure class is kept, and the generation starts at 0).

**Unknown historical state.** Migration 025 was revised twice inside the unmerged draft (the earliest revision lacked `SKIP LOCKED`, and
the current one has it). Migrations are applied by name with no checksum recorded, so the runner cannot detect a database that applied an
earlier revision of 025. The supported position is: no persistent database is known to have applied any draft 025, and `aegis_local` has
not been migrated. A deployment found to have applied an earlier draft must be inspected before it is upgraded. Its 025 body is not
re-run, and no revision is silently bypassed.

- Migration 025 was pushed to the unmerged draft in two revisions. No persistent database can be shown to have applied only one of them,
  so the safe rule is that a further change is a new migration.
- Migration 026 adds `cancellation_generation`, its non-negative CHECK, the replacement discovery function (same signature, extended return
  columns, so it must be dropped and recreated), and the orchestrator's column grant on the generation.
- Fresh installation runs 001 to 026. Upgrade from 024 applies 025 and 026 to a database holding a pending cancellation (test
  `cancellation-authority.integration.test.ts`, upgrade case, asserts generation 0 and the migration version). Migration count assertions
  are updated to 26 (fresh) and 11 (after 015).
- The earlier in-place edit to 025 (adding `FOR UPDATE SKIP LOCKED`) is retained as part of 025 and is not reverted.

## 10. Browser contract

The web panel says "Cancellation requested. It takes effect at the next step." That describes the request, not the finalisation. The text
is changed to say the cancellation is requested and that the orchestrator will finalise it. Terminal stage `cancelled` is shown only
after finalisation.

## 11. Test evidence

PostgreSQL integration tests run in CI on the final commit. Counts are in the PR, not repeated here. Unit tests run without a database.

- `cancellation.test.ts` (unit): discovery bounds, empty candidate set, applied and skipped outcomes, execution refusal, transient and
  systemic classification, halting on systemic and unrecordable faults, deferral on lock timeout without halting, continued processing,
  stale generation, injected faults, and backlog mapping.
- `cancellation-authority.test.ts` (unit): each validator check against a fake catalogue, including the new owner, role-map, schema and
  trigger event checks, and `CancellationAuthorityError` naming.
- `cancellation-concurrency.integration.test.ts`
  - the orchestrator and gateway runtime identities pass validation, and the gateway identity is refused as orchestrator;
  - A5.1 cancellation wins: a completion waits on the gateway's PID and is refused as `cancel_requested`;
  - A5.2 completion wins: the gateway request waits on the completion's PID and reports `terminal`;
  - A5.3a consumption first (trigger-level, direct SQL): the gateway request waits on the consumer's PID and is finalised afterwards;
  - A5.3b cancellation first: consumption is refused with 42501, the grant stays open until reconciliation, then is revoked;
  - A5.4 competing reconcilers: both discover one candidate; one reconciler holds the row lock before commit; the other is observed queued
    directly behind that holder's PID; exactly one applies, one skips, one cancelled event, no open grant, generation unchanged, no revival;
  - A5.5 opposing lock order (participant login on the consuming side): exactly one 40P01, the other side's outcome matches the victim,
    then recovery;
  - A6.1 to A6.14: poisoned-first, batch saturation, backoff, recovery, interruption between finalisation and recording, restart with a
    fresh pool, full-batch and multi-batch lock-aware fairness, a locked execution not blocking others, the generation guard (duplicate,
    stale, concurrent at 999 and at 1000, backoff after saturation, continued retries), the generation format, participant refusal,
    cross-tenant isolation, and backlog visibility;
  - connection lifecycle: a held lock does not hold pool connections, and an interrupted contention scenario is cleaned up.
- `approved-result-races.integration.test.ts` (section 12, item 9.2):
  - 12.1 cancellation wins: the reviewer's approved result, delivered to the production receive path, queues behind a cancellation that
    holds the execution lock; after the cancellation commits, the claim refuses, the result is recorded as processed without completing,
    no investigation result persists, the fencing token is unchanged, grants are revoked, one cancelled event exists, and a duplicate
    delivery is a duplicate;
  - 12.2 approved completion wins: the approved result persists its answer and citations under the held lock (paused at `release:accepted`);
    the gateway queues behind it and then reports terminal; the answer and citations are unchanged after repeated cancellation and
    reconciliation; no cancelled or cancel-requested event is written.
- `cancellation-production-races.integration.test.ts` (production path; scope and limits in section 12):
  - 9.1a cancellation commits first: the participant receive is refused with `cancel_requested`, the request grant stays open, and
    reconciliation finalises;
  - 9.1b consumption commits first: the request is processed and consumed, the later cancellation is accepted and finalises, and a stale
    triage result arriving afterwards does not revive the execution;
  - 9.1c concurrent, cancellation first: the gateway holds its row lock, the receive queues behind it (observed by blocker PID), and is
    refused once the cancellation commits;
  - 9.1d concurrent, consumption first: the receive holds its locks at the `receive:accepted` commit boundary, the cancellation queues
    behind the idle-in-transaction holder, then consumption commits and the cancellation is accepted and finalised;
  - 9.3 representative crash recovery: the reconciliation worker runs as a subprocess (`messaging-child.ts`, operation `cancel`), is paused
    at `cancel_finalise:applied` inside an uncommitted finalisation, and is killed with SIGKILL. The committed request survives, the
    interrupted finalisation leaves no trace, a new worker finalises exactly once, and a later cycle neither duplicates nor revives.
- `cancellation-authority.integration.test.ts`
  - fresh install to 026 and the validation passes;
  - upgrade from 024 with a persisted pending cancellation, through 025 and 026;
  - negative cases: PUBLIC, unexpected grant, unpinned search path, non-BYPASSRLS owner, BYPASSRLS owner without table privilege, missing
    function, overloaded signature, dropped trigger, disabled trigger, superuser runtime identity, runtime role membership, a BYPASSRLS
    owner with SELECT but without UPDATE for locking, a BYPASSRLS owner without role-map access, an AFTER trigger under the required name,
    and a required trigger attached to a different function.
- `auth/investigation-routes.integration.test.ts`: the public contract above: first request, duplicate, another principal (404, identical to
  unknown), cross-tenant (404), request after cancellation finalised (terminal), request after a completion committed first (terminal, and
  the succeeded execution is not overwritten).
- `investigation/gateway.test.ts`: request, idempotent repeat, lost race to terminal, principal refusal, finished executions.

Tests inject faults only through `ReconcileOptions.injectFault`, a test seam the runtime never passes. Backoff is exercised with a
persisted, test-only timestamp, not waiting.

## 12. Residual risks and unsupported guarantees

- **Not implemented:** a full crash matrix covering every instruction boundary. The crash test covers one representative boundary
  (`cancel_finalise:applied`) and one SIGKILL. Crashes inside the receive path are not tested by subprocess. Restart with a fresh pool
  remains a separate in-process test. Full matrix is deferred to later production qualification.
- **Approved-result race (9.2):** covered by two orderings on the production path (section 11). Its remaining limit is that the reviewer
  delivery is driven by the test through `receiveMessage`, not by the reviewer's own dispatcher and network path.
- **Participant consumption path.** The production-path races (section 11) use the participant login through `receiveMessage` at the
  `receive:accepted` commit boundary and at the lock wait. They do not cover a crash inside that path.
- **Narrowing the owner** to a dedicated NOLOGIN role remains a deployment qualification item, not an accepted risk.
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

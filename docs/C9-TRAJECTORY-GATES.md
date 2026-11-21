# C9 trajectory gates: versions, acceptance rules and limits

Status: development evidence only. Deterministic and mocked. C9 is PARTIAL. Nothing here is independent validation or
production qualification.

## Versions

### gates-v1 (frozen, historical)

Code: `apps/api/src/ai/trajectory/trajectory-evaluation-v1.ts`, `trajectory-harness-v1.ts`, `trajectory-gates-v1.test.ts`.
Not edited. Its tests still run.

- A side effect was taken from the dispatch result (`sideEffectCommitted`), not observed.
- An approval ID being presented was treated as an approval.
- Hard gates did not require coverage, so a missing scenario class did not fail.
- Efficiency thresholds (`maxCallsPerSuccess` 2.5, `maxAverageSteps` 2.5) were hard-coded as soft gates.

Its result on the 15-scenario set remains recorded as it was.

### gates-v2 (current)

Code: `trajectory-evaluation-v2.ts`, `trajectory-harness-v2.ts`, `trajectory-report-v2.ts`, `trajectory-v2.test.ts`.

What changed, and why:

1. **Observed state, not reported outcome.** The harness counts the synthetic state (notes and external sends) before and
   after each call. A change is recorded whatever the dispatcher returned. A failed step that changed state is a violation
   (`state_change_on_failed_step`).
2. **Approval means a consumption.** The approval store reports every consumption with the approval's own tenant, action
   digest, requester and expiry. A state change is authorised only by a consumption that matches the call's tenant, action
   digest and identity, and is not expired. Presenting an approval ID grants nothing.
3. **Coverage is a hard requirement.** Every class in `REQUIRED_CLASSES_IN_MEMORY` and `REQUIRED_CLASSES_DURABLE` needs at
   least one baseline run. Control runs do not count toward coverage. With no baseline runs, the gate fails.
4. **Detectors are tested by control runs.** Each control injects one faulty execution path and must be reported with its
   named violation. A missed control fails `controls_detected`.
5. **Efficiency is advisory.** It is reported with its thresholds and whether it was met, labelled advisory. It never
   changes pass or fail.
6. **Reports carry evidence without sensitive data.** Identifiers are SHA-256 digests (12 hex characters). Notes, arguments,
   approval IDs and subjects are not written out.

Hard gates (v2): `coverage_complete`, `no_unauthorised_side_effects`, `no_state_change_on_failed_step`,
`no_replayed_authority`, `no_wrong_tenant_consume`, `no_digest_mismatch_consume`, `no_expired_consume`,
`no_forbidden_allowed`, `no_specification_mismatch`, `no_negative_state_delta`, `no_duplicate_state_change`,
`no_unconsumed_approval_used`, `controls_detected`.

Control runs (faulty execution paths, each must be detected):

| Control | Injected path | Required detection |
| --- | --- | --- |
| `control_gateway_skips_approval` | gateway allows a write with no approval | `unauthorised_side_effect` |
| `control_gateway_consumes_wrong_tenant` | gateway consumes another tenant's approval | `wrong_tenant_consume` |
| `control_gateway_consumes_wrong_digest` | gateway consumes an approval for other arguments | `digest_mismatch_consume` |
| `control_gateway_consumes_expired` | gateway consumes an expired approval | `expired_consume` |
| `control_store_reuses_approval` | store accepts a second consumption | `replayed_authority` |
| `control_handler_writes_then_fails` | handler changes state and throws | `state_change_on_failed_step` |
| `control_durable_write_then_fail` (durable) | durable step changes state and fails | `state_change_on_failed_step` |

Durable scenarios (`durable-trajectories.integration.test.ts`, real PostgreSQL driver and store, mocked approval gate):
retry then success, permanent failure, retry exhaustion, recovery after interruption, cancellation, approval expiry after
grant, stale lease (a held lease refused, a stale write refused), and concurrency (one step for two workers).

## Acceptance rules

A candidate is accepted only if every hard gate passes on the full baseline and every control is detected. Advisory
efficiency is reported and reviewed, not gated. Thresholds for efficiency change only in a new version, decided before the
results are seen.

## Limits (stated, not hidden)

- The synthetic tools and the durable step are test fixtures. They are not production tools.
- No model is in these paths. Token cost cannot be measured here. The efficiency measures are call and step counts.
- The durable approval gate is a mock. Its consumption record is what the evaluator observes. The production approval store
  is covered by its own integration tests, not by this evaluation.
- Concurrency is tested with two workers in one process. It is not a load test.
- Control runs prove that the named detectors fire on the named faults. They do not prove that every possible fault is caught.
- No live inference was run. Live trajectories need separate authorisation.
- Independent qualification is outstanding. No external reviewer has reviewed the scenarios or the thresholds.

## gates-v3 (crash after commit, mandatory idempotent recovery)

Code: `apps/api/src/ai/trajectory/trajectory-evaluation-v3.ts` (built on v2, which is unchanged), `trajectory-v3.test.ts`, and the
crash scenarios in `durable-trajectories.integration.test.ts`.

What changed from v2, and why:

1. **Uncommitted outcome.** When a driver call throws after a state change has committed (for example, the connection is lost
   before the success is recorded), the step reports outcome `uncertain`. A change in such a step is not a failed-step violation:
   the effect committed, and the workflow outcome is unknown. It must still have a valid, consumed approval. Whether the crash
   was handled safely is decided by the duplicate rule and by the recovery run, not by the crash itself.
2. **Duplicate business effect.** Each durable run records what the synthetic business effect store observed, grouped by logical
   operation. A logical operation with more than one effect is a `duplicate_business_effect`, whatever the driver reported.
   New hard gate: `no_duplicate_business_effect`.
3. **Mandatory idempotent recovery.** `REQUIRED_CLASSES_DURABLE_V3` adds `idempotent_recovery` to the v2 durable list. The
   coverage gate fails without that baseline run. The v2 list is kept as recorded.

The crash scenario, end to end:

- A worker takes approval, runs the step, and the step commits the synthetic effect to PostgreSQL.
- The store's test seam (`beforeTransition`) throws when the driver tries to record `succeeded`. The effect has committed, the
  success is not recorded, and the driver call throws. The execution stays `running` with its lease held.
- Another worker recovers it after the lease expires (`lost_attempt_recovered`). The step does not run in recovery.
- A fresh approval is granted and the same logical operation runs again.

Two implementations are compared on the same path:

- **Idempotent** (baseline, class `idempotent_recovery`). The logical operation key is `notify-customer:<executionId>`, which is the
  same for every attempt. The idempotency record and the effect are written in one transaction. The retry finds the record and
  writes nothing. Result: one effect, no violation.
- **Non-idempotent** (control, expects `duplicate_business_effect`). The step records the effect every time it runs, with no check.
  Result: two effects for one logical operation. The evaluator reports `duplicate_business_effect` and `duplicate_state_change`.

Production behaviour: **no production workflow behaviour was changed.** The driver's contract is unchanged: a step may run again
after a crash, so the step must be idempotent under the execution id. The idempotency record exists in the synthetic effect
service in the test, not in the driver.

Production-file change, disclosed: `apps/api/src/workflow/durable-store.ts` gained an optional `beforeTransition` hook in
`DurableStoreHooks`. It is a crash-simulation seam for tests. Production passes no hooks, so the default is a no-op and no
behaviour changes. It is not a feature and needs no enabling.

What an idempotency record does and does not guarantee:

- It guarantees one recorded effect per logical operation **within the database that holds the record**, because the record and
  the effect commit in one transaction.
- It does **not** guarantee exactly-once behaviour for an external service. An external system must accept the operation key
  and deduplicate on it, end to end. Without that, a retry after an uncertain outcome can still repeat the external effect.
- The driver cannot know whether a step committed. That is why the step, not the driver, must carry the idempotency.

Recommended production work (not implemented here, and not enabled): carry a stable operation key from the workflow to every
effect service, and require external services to deduplicate on it. This needs owner review and a separate change.

Mandatory gate-v3 hard gates: `coverage_complete` (now including `idempotent_recovery`), `no_unauthorised_side_effects`,
`no_state_change_on_failed_step`, `no_duplicate_business_effect`, `no_replayed_authority`, `no_wrong_tenant_consume`,
`no_digest_mismatch_consume`, `no_expired_consume`, `no_forbidden_allowed`, `no_specification_mismatch`,
`no_duplicate_state_change`, `no_unconsumed_approval_used`, and `controls_detected`. Efficiency stays advisory.

Limits: the effect store is a synthetic table in a disposable database; the approval gate is a mock; one crash point is injected
(after the effect commit, before the success record). Other crash points (before the commit, during the recovery) are not
covered by this version.

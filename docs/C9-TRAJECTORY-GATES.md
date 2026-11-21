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

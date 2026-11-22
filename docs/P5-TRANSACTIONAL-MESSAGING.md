# P5: transactional outbox, durable dispatcher, transactional inbox, and SPIFFE-authenticated agent messaging

Status: **implemented and locally verified (in-process PostgreSQL, multi-process, containerised local stack). Not production-qualified.**

| Level | Meaning | P5 status |
| --- | --- | --- |
| Implemented | Migration 017, outbox and inbox store, dispatcher, runtime, operator CLI, Go agent proxy, compose services, tests, acceptance script. | Yes |
| Locally verified | PostgreSQL integration and multi-process tests against a disposable PostgreSQL 17; the containerised acceptance on the local stack (section 8). | Yes, with the caveats in section 9 |
| Production-qualified | Independent security review, a containerised test of the dispatcher under load, production secret handling for runtime credentials, backup and restore of the message tables, retention enforced by a scheduled job, and an authenticated operator process. | No |

P5 adds one deterministic, read-only workflow between two independently running agents. It does not enable general agent execution, model inference, tool calls, or any external business effect.

## 1. What is guaranteed, and what is not

The transaction model guarantees the following, and the tests check each one directly in PostgreSQL:

- **Atomic production of a message.** A P4 decision and the outbound message it produces commit in one transaction. A decision that fails before commit leaves no message, no grant and no delegation (section 4.1). The decision and the message are one commit, not two.
- **Single consumption of a grant.** A receiver consumes an inbound grant under the execution row lock. Ten concurrent deliveries of one message produce one processing (section 7.2).
- **Idempotent local effect per message.** The inbox row for (receiver, message) is inserted first and is unique. A repeated delivery returns the stored outcome and runs no local effect again.
- **No silent loss.** A message leaves the system only in state `delivered`, or in state `dead` with a bounded reason. Dead messages stay in the table until an operator requeues them or retention removes delivered rows.

The following is **at-least-once delivery**, and P5 does not claim otherwise:

- A dispatcher that crashes after the receiver commits but before the acknowledgement is retried. The receiver returns the stored outcome, so the local database effect happens once. The message is delivered at least once and processed once.
- A stale dispatcher's acknowledgement is refused by its fencing token, so the message can be sent again by the new lease holder. This is intended.
- P5 has no external business effect. For any future external action, the external system must enforce idempotency on the message identifier. Without that, a retry can repeat the external effect. P5 does not claim exactly-once business effects.

## 2. Schema (migration 017, additive)

| Table | Purpose | Key controls |
| --- | --- | --- |
| `agent_outbox` | One row per outbound message: identifiers, tenant, execution, sender, destination, kind, the C8 envelope (10 fixed fields, no arguments), the payload (bounded arguments or result), the payload digest, lifecycle, attempts, lease and fencing token, backoff time, bounded last error and dead-letter reason. | CHECK on sizes (4 KiB envelope, 8 KiB payload), digest format, state consistency, `sender <> destination`. Trigger `forbid_outbox_rebinding`: content and digest immutable, delivered final, dead only moves through requeue, counters never decrease. |
| `agent_inbox` | One row per (receiving agent, message): the verified sender, kind, payload digest, outcome (`received`, `processed`, `refused`), refusal reason, grant id, result message id, result digest. | Primary key (receiver, message) is the deduplication guarantee. Trigger `forbid_inbox_rebinding`: identity immutable, outcome final. |
| `agent_message_events` | Append-only audit of message transitions: enqueued, leased, delivered, retry scheduled, dead lettered, acknowledgement refused, requeued, inbox processed, inbox duplicate, inbox refused. | No content. Trigger refuses update and delete. |
| `agent_outbox_actions` | Append-only operator actions (requeue), with a digest of the operator identity and a bounded reason. | Trigger refuses update and delete. |

Indexes: a partial index on `(sender_agent, next_attempt_at)` for undelivered rows (the claim cost does not grow with history); indexes by execution and by tenant for dead and delivered rows.

Migration 017 was added after 016 and does not change any applied migration. Checksums are verified by the migration runner.

## 3. Row level security and least privilege

- **Tenant scope** (`aegis.tenant_id`): reads and inserts for the tenant of the transaction, as in migration 016.
- **Dispatch scope** (`aegis.agent_id`): a dispatcher sees and updates only messages whose sender is its own verified agent. This is the one cross-tenant path, and it is deliberate: a dispatcher serves all tenants for its sender. It is limited to lifecycle columns by column grants; content and digest columns are not writable by the runtime role at all.
- Both settings are set per transaction by the runtime from its verified identity. Neither is read from message content.
- The runtime role is `aegis_app`. Column-level grants exclude `envelope`, `payload`, `payload_digest`, `sender_agent`, `destination_agent`, and every identity column of the inbox.
- Tests check each rule directly: a rewrite of payload is refused with `42501`; a forged processed inbox row is refused; deletion of audit rows is refused; a dispatcher for `triage` cannot acknowledge an `orchestrator` message; tenant B cannot read tenant A's messages.

**Known residual risk.** Any process that holds the `aegis_app` password can set `aegis.agent_id` to any registered agent. That is the same trust domain as the password. A dedicated dispatcher role with its own credential is the follow-up (section 9).

## 4. Atomic decisions

### 4.1 Delegation, grants and message in one commit

`delegateAndDispatch` (`messaging/workflow.ts`) runs the P4 store's own methods inside one transaction (`joinTransaction`):

1. `recordDelegation` (pure C8 rules, under the execution lock, fenced);
2. `issueGrant` for the request (kind `request`, forward);
3. `issueGrant` for the return (kind `result`, direction `return`), so the reply is authorised before it exists;
4. `enqueueMessage` with the request envelope, derived from the recorded hop and the grant fields, and the payload that the envelope digests;
5. `release` of the lease to `pending`.

A refusal at any step rolls back to a savepoint, so no hop, grant or message survives it. Only the refusal audit row is written. A failure that throws before commit rolls back everything (test in `messaging.integration.test.ts`).

### 4.2 Extension to C8 (deliberate, documented)

C8's `issueGrant` only grants in the forward direction: from the holder before the last hop to the last hop. A result has to travel back, and C8 has no rule for that. P5 adds a `direction: 'return'` option, valid only for `kind: 'result'`, which grants from the last hop back to the agent that delegated it on the same chain. The default (`forward`) is C8's behaviour and is unchanged. The change is in `delegation.ts`; the C8 unit tests still pass. If PR #77 is changed, this extension must be re-ported with it.

### 4.3 Recipient consumption

`receiveEnvelope` (P4 store) is the recipient's path. It takes no lease, because the recipient is not the lease holder. It checks, in order: terminal status; structure (C8); addressed to this recipient (`wrong_recipient`); sent by the verified sender (`sender_mismatch`); then the C8 authorisation and single-use consumption, which is the same code the fenced path uses (`consumeDecision`). A result addressed to the root agent also finalises the execution (`succeeded`) under the same lock, and revokes any open grants.

## 5. Dispatcher

`dispatchOnce` (`messaging/dispatcher.ts`), run in a loop by the runtime or as a one-shot test:

- **Claim.** `FOR UPDATE SKIP LOCKED` on due rows for its sender: pending rows whose time has come, and leased rows whose lease has expired (recovery). Each claim increments the fencing token and the attempt count, and sets the lease with `clock_timestamp()`. Concurrent dispatchers lease disjoint messages (tests).
- **Deliver.** Only through the local egress proxy, which performs the mTLS to the destination. The dispatcher never opens a network connection to a peer.
- **Outcome.** A 200 from the peer means the peer committed its inbox transaction, and the dispatcher acknowledges, fenced. A transport failure, 5xx or 429 schedules a retry with backoff. A permanent refusal (403 identity, 404 destination, 409 receiver refusal, 422 invalid message) dead-letters at once with its reason.
- **Backoff.** `min(60 s, 2^(attempts-1) s) × jitter(0.8–1.2)`, applied to the database clock. Attempts are bounded by `max_attempts` (default 6). An exhausted budget dead-letters with `retry_exhausted` and keeps the last transport reason in `last_error`.
- **Fencing.** Acknowledgement, retry and dead-letter each require the fencing token of the claim and an unexpired lease. A stale holder's write changes nothing and is recorded as `ack_refused`.
- **Time.** Every lease and delay uses the database clock.

## 6. Identity path

| Link | Mechanism | What is verified |
| --- | --- | --- |
| Agent workload | SPIRE Workload API, one registration per UID (P3 entries for `orchestrator` UID 1001 and `triage` UID 1002). | The SVID is issued only to a process the SPIRE agent attests in its PID namespace. |
| Agent proxy (Go, `infra/spire/workload/proxy.go`) | Inbound: mTLS server, client accepted only if its SPIFFE ID is in `allowClients`. Outbound: one client per peer, pinned to that peer's exact SPIFFE ID (`tlsconfig.AuthorizeID`). Identity: reports its own SPIFFE ID. | Both peers cryptographically, exact allow-list. Configuration is baked into a small image per agent (`infra/spire/messaging/`). |
| Runtime (Node) | Shares the proxy's network namespace; reaches the proxy only on loopback. Refuses to start unless the proxy's identity is the registration of `AEGIS_AGENT_ID`. | Registration binding before any execution, grant or message operation. |
| Inbox | The proxy forwards the verified peer as `x-aegis-peer-spiffe-id` and discards any such header from the client. The runtime resolves the peer to a registration; unknown peers are refused before any database write. | The sender of a message is the verified peer, never a value in the body. |

Trust boundaries: the runtime trusts the loopback proxy in its own network namespace, in the way a sidecar is trusted. A message body is never trusted for identity, tenant, scope or principal. Tenant comes from the message only to select the RLS scope; the grant check then has to match in that tenant, so a forged tenant finds no execution (test: cross-tenant delivery).

The proxy's `pid: service:<agent>` placement is required by P3's attestation design. A workload container that is recreated must have its SPIRE agent recreated too, or new processes cannot be attested (section 9).

## 7. Tests

Command: `npm run test:messaging` in `apps/api` (see section 10), plus the existing P4 and storage suites. All integration tests run on PostgreSQL 17 with the migrations applied, as `aegis_app` for the code under test and as the administrator only for setup and assertions.

### 7.1 Pure (no database)

`wire.test.ts`, `telemetry.test.ts`: wire structure and digest binding; tampering of payload and argument digests; unexpected fields (a message cannot carry grant or authority fields); schema version; foreign message identifier; oversized payloads; backoff bounds; triage effect and strict argument shape; bounded metric labels.

### 7.2 In-process with the real inbox and outbox (`messaging.integration.test.ts`)

Covers: atomic commit of decision and message; refused delegation writes only the refusal; injected failure before commit leaves no message; full request → result → finalisation; repeated delivery; six concurrent deliveries of one message (one processed); payload and argument-digest tampering refused before any write; replayed grant under a new message identifier (`grant_consumed`); wrong recipient; sender mismatch; unregistered peer (403); cross-tenant execution (`not_found`); expired grant (`not_granted`); retry, dead letter after budget, audited requeue and recovery; permanent refusal dead-letters at once; unreachable peer retried, never dropped; stale acknowledgement refused after lease recovery; concurrent claims disjoint (SKIP LOCKED); cross-sender and cross-tenant isolation; retention refuses the window; database least privilege; append-only audit and final delivery.

### 7.3 Multi-process crash and concurrency (`messaging-multiprocess.integration.test.ts`)

Each scenario starts real Node processes (`messaging/testing/messaging-child.ts`) that run the real code, is stopped at a labelled point with `SIGKILL`, and is checked directly in PostgreSQL.

| Scenario (request, section 8) | Test | Result |
| --- | --- | --- |
| Crash before the execution/outbox transaction commits | decision child killed before `release:accepted` commits | no delegation, grant or message; lease still held |
| Crash immediately after the commit | decision child killed after its commit | message durable, dispatched once |
| Dispatcher crash before delivery | dispatcher child killed before the request is sent | message leased; recovery after lease expiry delivers once with fencing token 2 |
| Dispatcher crash after delivery, before acknowledging | dispatcher child killed after the receiver committed | redelivery suppressed by the inbox, acknowledged, one processing |
| Receiver crash before its inbox transaction commits | receiver child killed before commit | nothing persisted; redelivery processes once |
| Receiver crash after commit, before acknowledging | receiver child killed after commit | stored outcome returned; one result message; one grant consumed |
| Duplicate messages, concurrent delivery across processes | two receiver processes at the same instant | one processed, one duplicate |
| Three dispatchers at once | 12 messages, 3 processes | each message delivered exactly once |
| Database restart and recovery | `docker restart` of a disposable PostgreSQL container, guarded by `P5_TEST_CONTAINER` | message still pending after restart; delivered once after |

Lease expiry and stale-worker fencing are also in 7.2.

## 8. Containerised workflow (local stack, profile `messaging`)

Services (compose profile `messaging`, not started by a plain `up`):

| Service | Image | Runs as | Shares namespace with |
| --- | --- | --- | --- |
| `p5-orchestrator-proxy` | `aegis-p5-orchestrator-proxy:local` (P3 workload image + `orchestrator-proxy.json`) | UID 1001 | PID namespace of `orchestrator` (P3) |
| `p5-orchestrator-runtime` | `aegis-api:local`, `apps/api/dist/orchestration/messaging/runtime.js` | non-root, read-only root filesystem | network namespace of `p5-orchestrator-proxy` |
| `p5-triage-proxy` | `aegis-p5-triage-proxy:local` | UID 1002 | PID namespace of `triage` (P3) |
| `p5-triage-runtime` | `aegis-api:local` | non-root | network namespace of `p5-triage-proxy` |

The P3 `spire-agent-orchestrator` and `spire-agent-triage` attest these processes through the shared PID namespaces.

The acceptance script `scripts/p5-acceptance.mjs` runs the sequence below, and every step is a printed check. Its output is recorded in section 8.1.

1. Migration 017 applied through the migrate service; both SPIRE agents recreated; both workloads report `workload_started`.
2. Both runtimes healthy; both proxies report their own SPIFFE IDs; the runtime refused no identity.
3. Identity adversaries over real mTLS: the allowed control completes (exit 0); `reviewer` (registered, not allowed) is refused by the triage proxy (exit 3); an unregistered `probe` workload gets no SVID and cannot connect.
4. The orchestrator starts a tenant-bound execution (fresh case per run), commits delegation, grants and the request message, and the execution reaches `succeeded` through delivery over mTLS, consumption at triage, the result message, and finalisation at the orchestrator.
5. The request was delivered once (attempts 1, fencing 1); triage returned exactly one result (`documents_present`, 3 documents); both inboxes recorded `processed`; each grant was consumed by its recipient.
6. A repeated delivery through the real egress is answered as a duplicate; no second result is produced.
7. Receiver outage: triage is stopped; the orchestrator retries and dead-letters with `retry_exhausted` and `peer_unreachable`; the dead letter is visible to the operator query; triage is restarted; an audited requeue delivers the message.
8. The runtime role cannot rewrite message content (`42501`).
9. Traces (`aegis-p5-orchestrator-proxy` service) are queryable in Tempo, and delivery metrics are queryable in Prometheus, both through Grafana's proxy.

### 8.1 Acceptance results

Final run (`node scripts/p5-acceptance.mjs --no-build`, exit 0), 27 of 27 checks passed:

| Group | Checks | Result |
| --- | --- | --- |
| Migration and readiness | 1 migration recorded; SPIRE identities issued; both runtimes serving; both proxies report their identities; no identity refused | 6 of 6 |
| Identity adversaries (mTLS) | allowed control exit 0; wrong SPIFFE peer exit 3; unregistered workload exit 1 | 3 of 3 |
| Workflow | execution created and dispatched; reached succeeded; request delivered once (attempts 1, fencing 1); one result (`documents_present`, 3); both inboxes processed; grants consumed by their recipients; authoritative state `succeeded|1|2`; projection agrees | 8 of 8 |
| Duplicates | repeated delivery through the real egress answered as duplicate; no second result | 2 of 2 |
| Outage and recovery | retry then dead letter (`retry_exhausted`, `peer_unreachable`); dead letter visible to the operator query; audited requeue; delivery after recovery; requeue in the operator audit | 5 of 5 |
| Least privilege | runtime role cannot rewrite message content (`42501`) | 1 of 1 |
| Observability | traces for the proxy service queryable in Tempo; delivery metrics queryable in Prometheus | 2 of 2 |

Issues found and fixed during the containerised work, recorded because each one changed the design or the procedure:

- Bind-mounted proxy configuration was created as an empty directory by the Docker runtime (the project path is not shared with it). Fixed by baking each agent's configuration into a small image.
- A recreated workload container left its SPIRE agent attached to the old PID namespace, so new processes could not be attested. Fixed in the acceptance script (agent pair recreated, workloads awaited) and documented in `SPIRE-WORKLOAD-IDENTITY.md` section 10.
- A result query used an operator precedence that PostgreSQL parsed differently. Fixed with parentheses; the acceptance helper now reports SQL errors as failed checks instead of stopping.
- The acceptance reused a fixed case identifier, so a second run was refused as a terminal execution (correct behaviour). The script now uses a fresh case per run.

### 8.2 Test and build results

Local, on this machine, against a disposable PostgreSQL 17 container (`aegis-p4-test-postgres`, test credentials, loopback only):

| Check | Result |
| --- | --- |
| API unit tests (`npm test` in `apps/api`) | 113 files, 1081 tests passed |
| PostgreSQL integration (`vitest run --config vitest.integration.config.ts`, full) | 20 files passed, 9 skipped; 235 tests passed, 11 skipped |
| P5 in-process integration (`messaging.integration.test.ts`) | 23 tests passed |
| P5 multi-process and restart (`messaging-multiprocess.integration.test.ts`) | 9 tests passed with `P5_TEST_CONTAINER` set; 8 passed and the restart test is skipped without it |
| P5 pure (`wire.test.ts`, `telemetry.test.ts`) | 11 tests passed |
| P4 store, multi-process, migration and telemetry (`src/orchestration`) | passing; included in the integration totals above |
| Go vet and unit tests (`workload/Dockerfile.test`) | 8 tests passed; vet clean |
| `npm run lint` (root) | exit 0 |
| `npm run typecheck` (all workspaces) | exit 0 |
| `npm run build` (all workspaces) | exit 0 |
| `git diff --check` | clean |
| Migrations | fresh database: 17 applied; a database at 016 upgrades by one (017) and a second run applies nothing; checksum tampering is refused |
| Local stack | migration 017 applied (`applied: 1`); acceptance 27 of 27 |

The skipped integration tests are gated by environment (for example, suites that need a live provider, and the database-restart test, which needs `P5_TEST_CONTAINER`). They are not counted as passed.

GitHub CI is not part of these local results; it is reported on the pull request.

## 9. Gaps, residual risks and follow-ups

CI on the pull request is not reported here; see the pull request for its status.

- **Dispatcher credential.** The dispatch scope uses a session setting, so the runtime role can act for any registered sender. A dedicated `aegis_dispatcher` role, with only the lifecycle grants on the outbox and no inbox access, is the follow-up.
- **Operator authentication.** `requeue` and `purge` run as a process with database access. They record a digest of the operator and a reason, but there is no operator identity provider. An authenticated operator process is required before production.
- **Retention.** `purge` deletes delivered messages older than a cutoff on demand; no scheduled job runs it. Inbox rows are not purged, and they must outlive the longest possible redelivery window. Both need a retention policy and a job.
- **Load.** No load test has been run. The concurrency numbers in section 8.2 are from one run on one machine, not capacity figures.
- **Proxy and runtime in one trust boundary.** The runtime relies on loopback isolation within its network namespace, as a sidecar does. A compromise of the runtime can send any message its proxy is allowed to send. It cannot obtain a SPIFFE identity of its own.
- **SPIRE operations.** A workload container that is recreated must have its SPIRE agent recreated (P3 design). The acceptance script does this. Operationally, a stalled SPIRE OPA authorisation (`eval_cancel_error`) was seen once during this work, which delayed SVID issuance until the server recovered. It needs its own investigation.
- **Telemetry.** Metrics and spans are emitted by the runtime and proxies; dashboards and alert rules are not yet written.
- **Tempo WAL (P7).** Unchanged and still open. P5 does not depend on Tempo for correctness: application correctness is shown in PostgreSQL.
- **Not reviewed.** No independent security review of P5 has been done. C6 and C10 remain the independent assessment referenced by the production plan.

## 10. Commands

From `apps/api`, with `TEST_DATABASE_ADMIN_URL`, `TEST_DATABASE_URL`, `DATABASE_APP_PASSWORD` and `DATABASE_INGEST_PASSWORD` set:

```bash
npx vitest run src/orchestration                        # pure C8, wire, backoff, telemetry (no database)
npm run test:messaging                                  # P5 PostgreSQL, multi-process and inbox/outbox integration tests
npm run test:execution                                  # P4 store, migration and telemetry integration tests
```

Container acceptance (from the repository root, with the aegis-local stack and SPIRE registrations up):

```bash
node scripts/p5-acceptance.mjs                          # builds images, applies migrations, runs the workflow and checks
node scripts/p5-acceptance.mjs --no-build               # when images already contain this commit
```

Go vet and unit tests for the proxy and the workload run in a build image (from `infra/spire`: `docker build --no-cache -f workload/Dockerfile.test -t aegis-workload-tests:local .`).


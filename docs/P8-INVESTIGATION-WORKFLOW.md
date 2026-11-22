# P8: evidence-backed investigation workflow

Status: **in progress (branch local-platform-p8). Implemented in part and locally verified in part. Not production-qualified.** The status
of each capability is stated in section 10. Nothing here has had the independent security review required by the C6/C10 production gate.

## 1. What the workflow does

An authenticated user asks a question about a tenant's documents. The system answers only from authorised evidence, and a second agent
checks the answer before it is returned. Otherwise it reports insufficient evidence or failure.

```
browser (Keycloak sign-in) → authenticated API → gateway (aegis_gateway) → execution (P4) + question record
                                                       │ intake (orchestrator, aegis_orchestrator)
                                                       ▼
   orchestrator ── request: plan ──────────► triage     (classifies; proposes a bounded plan)
   orchestrator ◄── result: plan ───────────┘
   orchestrator ── request: evidence ──────► retrieval  (tenant documents, under its own role)
   orchestrator ◄── result: evidence ───────┘
   orchestrator ── request: review ────────► reviewer   (checks the candidate against the evidence)
   orchestrator ◄── result: review ─────────┘
   orchestrator: finalise (answered | insufficient_evidence | failed) → investigation_results
```

Every arrow is a P5 outbox message, delivered by the sender's dispatcher over SPIFFE-authenticated mutual TLS, and processed once by the
receiver's transactional inbox. Every orchestration decision is a P4 fenced decision under the execution lock.

## 2. Security weaknesses closed (section 1 of the brief)

| Weakness (P5) | Closure in P8 | Evidence |
| --- | --- | --- |
| The shared `aegis_app` role and a caller-set `aegis.agent_id` session setting decided which agent a session acted as. | Each workload connects with its own database role (`aegis_orchestrator`, `aegis_triage`, `aegis_retrieval`, `aegis_reviewer`), plus `aegis_gateway` and `aegis_operator`. The agent is `aegis.current_agent()`, derived from `current_user` through the server-owned mapping `aegis.agent_database_roles`. The session setting is no longer read by any policy. The roles are not members of one another, so `SET ROLE` is not a route. The runtime refuses to start if its login role is not the mapped agent (`verifyAgentRole`). | `investigation.integration.test.ts`: triage cannot insert a forged retrieval message, cannot change `aegis.current_agent()` by setting the session value, cannot consume retrieval grants, cannot insert delegations or grants, cannot change registrations, executions, stages or results, and cannot requeue or purge. |
| A request could name a principal, or an execution could be submitted for another tenant. | The gateway takes the principal from the verified token, checks membership in the database, derives the principal digest itself, and records the investigation scopes from a fixed ceiling. Extra body fields are removed and never used. | `investigation-routes.integration.test.ts` (8 tests); the acceptance refuses a member of another tenant. |
| `requeue` and `purge` were unauthenticated commands on the runtime credential. | They run under `aegis_operator` only, through `cli.js` in a separate `p8-operator` container that is not started by `up`. The orchestrator and agent runtimes do not hold the operator credential. Operator actions are audited with an operator digest. | `messaging.integration.test.ts`: only the operator role can requeue; the acceptance checks the orchestrator cannot. |
| The P5 CLI could start an execution for a supplied principal. | `submit` exists only for synthetic acceptance: it requires `--synthetic-acceptance` and the synthetic issuer, and it uses the gateway role. Authenticated operation is through the API. | Code review of `messaging/cli.ts`. |

Migration 018 is additive; migration 019 corrects one function after 018 was applied to existing databases. No migration from 001 to 017 was changed.

Known residual risks, stated plainly:
- The orchestrator role is tenant-scoped by the tenant setting. A compromised orchestrator process can act for any tenant. This is inherent to a multi-tenant orchestrator and is the first item for the production review.
- The gateway role reads memberships for any principal and filters by the verified principal in the query. A compromised gateway can read any tenant's investigation status.
- Database credentials are long-lived passwords in local environment files. Production needs workload-issued short-lived database credentials (for example SPIFFE-authenticated database login). Not built.
- The API verifies tokens in the application process, then calls the database as the gateway role. The database cannot verify the token itself.

## 3. Workloads (section 2 of the brief)

Four SPIFFE workloads, each with a proxy (Go, the P3 workload binary, `proxy` subcommand) and a runtime (Node, the P5 runtime). Peer allow-lists are
exact: the orchestrator is the only peer of triage, retrieval and reviewer; those three may reach only the orchestrator.

| Agent | UID | SPIFFE ID | Database role | Proxy inbound allow | Proxy outbound peers |
| --- | --- | --- | --- | --- | --- |
| orchestrator | 1001 | spiffe://aegis.local/workload/orchestrator | aegis_orchestrator | triage, retrieval, reviewer | triage, retrieval, reviewer |
| triage | 1002 | spiffe://aegis.local/workload/triage | aegis_triage | orchestrator | orchestrator |
| retrieval | 1003 | spiffe://aegis.local/workload/retrieval | aegis_retrieval | orchestrator | orchestrator |
| reviewer | 1004 | spiffe://aegis.local/workload/reviewer | aegis_reviewer | orchestrator | orchestrator |

Each runtime shares its proxy's network namespace and reaches the proxy only on loopback. Each proxy shares the PID namespace of its SPIRE
agent's workload, as in P3. A recreated workload needs its SPIRE agent recreated (P3 rule); the acceptance does this.

## 4. Orchestration and the stage machine (section 4)

The stage of an investigation is stored on the execution (`workflow_stage`, migration 018). The database checks every transition against a
fixed graph (`aegis.stage_transition_allowed`). The orchestrator decides which stage follows; the database refuses a transition the graph does not allow,
even from the orchestrator role (tested: `completed` cannot be set from `triage_requested`).

```
submitted → triage_requested → plan_received → retrieval_requested → evidence_received → review_requested → review_received → completed
                                   │                    │                                                         │
                                   └─► insufficient_evidence ◄──────────────────────────────────────────────────────┘ (and failed / cancelled from any non-terminal stage)
```

Rules enforced in code (`messaging/handlers.ts`), each under the execution lock and each in the same transaction as its message:
- A result is accepted only from the sender expected at the current stage. A result that arrives after cancellation is consumed and discarded.
- A plan's query must consist of words taken from the question (`validatePlan`). A plan cannot add a term, a permission or a scope.
- The triage, retrieval and reviewer requests and their result grants are issued by the orchestrator's P4 decisions. Scopes come from the orchestrator's constants.
- Finalisation is not a side effect of receiving a result. Only `completed` (reviewer approval), `insufficient_evidence` and `failed` end an investigation; an intermediate result cannot.
- Budgets: `max_delegations 3` (one each for triage, retrieval, reviewer), `max_steps 12`, `max_depth 2`, `max_attempts 10` claims. A complete run uses 3 delegations and 6 accepted envelopes.

Delegation model against C8 (PR #77, `08c305f`):
- Each delegation is a root-to-agent hop (depth 1). The three hops are distinct chains, so the P4 chain-digest uniqueness applies.
- Grants are single-use, expire after the grant TTL (enforced in the policy and by a trigger), and are checked by exact match on kind, chain, depth, sender, recipient, action and arguments digest.
- The return direction for results is an extension to C8 (`issueGrant(direction: 'return')`, result grants only). The forward behaviour is C8's and is unchanged. A revision loop is not implemented: a rejected review ends the investigation as `failed`, which keeps the chain-digest uniqueness simple. Revision is a follow-up that needs a distinct chain per revision.

## 5. Triage, retrieval and review (section 3)

- **Triage** (`investigation/triage.ts`, deterministic): classifies a question as a document question or out of scope, and proposes a query of up to three words taken from the question, with the reviewer criteria. It proposes only; the orchestrator validates the plan (`investigation/contracts.ts`).
- **Retrieval** (`investigation/evidence.ts`): reuses the existing tenant-scoped lexical retrieval (`documents/retrieval.ts`, PostgreSQL full-text search over `aegis.document_chunks`) under the retrieval role. The role's read policy requires that the retrieval agent participates in an execution of that tenant (`document_retrieval_participant`). Items matching prompt-injection markers are removed and counted. No item is generated.
- **Review** (`investigation/review.ts`): the candidate is composed extractively from the evidence (each claim is a substring of its cited excerpt). The reviewer checks, in order: that each citation resolves to the authorised evidence, that each claim is supported by its excerpt, that no other evidence contradicts it (a bounded lexical heuristic, not a proof), that the answer is relevant to the question, and that the text is safe and within size. It returns `approve`, `insufficient_evidence` or `reject` with reason codes. An approval with reasons is refused by the typed contract.

PR review (section 3, on PRs #74 and #75): PR #75 (C2) adds verification tests, documentation and a latency benchmark; it adds no runtime retrieval code beyond the base branch. PR #74 (C1) adds a disabled-by-default context assembler on another branch. Neither is ported. The base's retrieval is reused. The C2 review's findings are inherited as limits: the lexical path has no paraphrase recall (its own measurement: MRR 0.125 against 0.542 for vector on the small paraphrase set), and it stops at its context byte budget without reporting the cut. The retrieval agent does not yet report truncation.

## 6. Typed contracts and model interfaces (section 5)

- Typed contracts exist for the plan, the evidence bundle, the candidate, and the review (`investigation/contracts.ts`), with validators used at every boundary.
- The model-backed triage, retrieval planning and reviewer behind these contracts are **not implemented in this milestone**. The deterministic agents are the implementation. No live inference is enabled, and no model is downloaded. The provider interface, token and cost metrics, and evaluation fixtures are the next work, behind the same contracts.

## 7. Browser (section 6)

The protected area (`apps/web/src/auth/InvestigationPanel.tsx`) shows, after Keycloak sign-in: a tenant choice, a question, an idempotent submit (the key is created once per question and reused by retries), status polling until a terminal stage, the cited answer, an insufficient-evidence or failure message, and cancellation. The browser holds no agent endpoint, no SPIRE socket and no database credential. Every call is a bearer-authorised request to the API.

## 9. Results

Test and build results from this checkpoint (commit `916a8d5` and the following local changes):

| Check | Result |
| --- | --- |
| API unit tests (`src/investigation/review.test.ts`, pure) | 10 tests passed |
| P8 PostgreSQL: investigation end to end, adversarial and stage machine (`investigation.integration.test.ts`) | 15 tests passed |
| P5/P8 messaging PostgreSQL (`messaging.integration.test.ts`) | 16 tests passed |
| P5/P8 multi-process crash and restart (`messaging-multiprocess.integration.test.ts`) | 9 tests passed (restart test needs `P5_TEST_CONTAINER`) |
| Authenticated investigation API (`auth/investigation-routes.integration.test.ts`) | 8 tests passed |
| P4 persistence (store, multi-process, migrations, telemetry) | 32 + 3 tests passed (multi-process and migration suites run separately) |
| Go vet and tests (proxy and workload) | 8 tests passed |
| `npm run lint` on changed sources; `tsc --noEmit` for the API | clean |
| Local stack acceptance (`scripts/p8-acceptance.mjs`), latest complete run | 37 of 38 checks passed. The single failure was Tempo search, during a window in which Tempo had been stopped by an operator mistake (see below). Not yet re-run. |

Not yet verified on the local stack: the answer path with real evidence. The synthetic corpus is in the disposable test database only,
because seeding the local database goes through the gated ingestion path (`ingestSyntheticCatalogLocal`), which requires an explicit
local opt-in and a verified desktop Docker context that this machine does not have. The answer path is verified in the test database.

Operational events during this checkpoint, recorded for the review:
- A stop command issued without a service list stopped the observability and web services; they were restarted. Probe, rogue and intruder containers were also stopped and restarted.
- The local Keycloak container became unhealthy after restarts (JGroups JDBC_PING join timeouts), and at one point consumed most of the VM CPU. It was recreated (container only; no data volume removed). At the time of this checkpoint it was still rebuilding its configuration image.
- The Docker VM was under heavy load for much of the session; some command timeouts were caused by that load, not by the code.

## 10. Status by capability

| Capability | Status | Basis |
| --- | --- | --- |
| Per-workload database identity (migration 018/019) | Implemented; locally verified | Integration tests; local stack |
| Authenticated investigation API | Implemented; locally verified against the local Keycloak | Route integration tests; acceptance |
| Four SPIFFE workloads with mutual TLS | Implemented; locally verified | Acceptance (identity and peer refusals) |
| Stage machine and orchestration | Implemented; locally verified | Investigation integration tests |
| Retrieval over PostgreSQL | Implemented (lexical); locally verified on the test corpus | Investigation integration tests |
| Reviewer | Implemented (deterministic checks); locally verified | Unit and integration tests |
| Model-backed agents | Not implemented | Section 6 |
| Browser investigation page | Implemented; not yet exercised in a real browser session | Component compiles; browser run pending |
| Operator boundary | Implemented as a separate role and container; no authenticated operator identity | Acceptance and tests |
| Observability (traces, delivery metrics) | Traces and delivery metrics from P5; stage and investigation metrics not yet | Acceptance |
| Production qualification | Not claimed | C6/C10 independent review not done |

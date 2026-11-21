# AEGIS production-local assessment and dependency-ordered plan

Status of this document: **assessment and plan**. It records what was verified in the repository on 2026-11-21 and what must be built, in order, with acceptance criteria. It claims no capability as complete. Every capability named here keeps its register status until the acceptance criteria in its section are met and evidenced.

Base: `origin/c10-security-hardening` (`ff7156e`). This document does not depend on, and does not include, C6 (PR #76) or C8 (PR #77). Those branches are referenced, not merged.

## 1. Verified repository state

### 1.1 Pull requests (checked with `gh pr list`, 2026-11-21)

| PR | Head | Base | State | Notes |
| --- | --- | --- | --- | --- |
| #69 | `feat/durable-agent-state-machine` | `main` | open, not draft | State machine, context assembly, ranking metrics, output guard, tool policy gateway. Title still says draft |
| #70 | `c4-answer-quality-v8-review` | #69 branch | open | C4 development after owner review |
| #71 | `c5-durable-observability` | #70 branch | open | C5 observability and cancellation audit |
| #72 | `c10-security-hardening` | #71 branch | open | C10 hardening; base of C6 and C8 |
| #73 | `c9-trajectory-gates` | `c10-security-hardening` | open | C9 trajectory gates; sits on the C10 base |
| #74 | `c1-context-assembler-flag` | #73 branch | open | C1 behind a disabled flag |
| #75 | `c2-retrieval-verification` | #74 branch | open | C2 verification |
| #76 | `c6-mcp-server` | `c10-security-hardening` | open, ready | C6 MCP, head `c90b26a`; independent review pending |
| #77 | `c8-design-foundation` | `c10-security-hardening` | open, **draft** | C8 pure design, head `08c305f` |

Dependabot PRs #4, #48–#52 are open against `main` and are out of scope here.

Stack note: C6 and C8 both branch from C10 and do not contain each other. C9, C1 and C2 form a separate continuation. Nothing in this plan merges any of them.

### 1.2 Local infrastructure (verified in the working tree)

| Artifact | Contents | Assessment |
| --- | --- | --- |
| `docker-compose.yml` | One service: PostgreSQL 17 with pgvector, bound to 127.0.0.1, healthcheck | The only local runtime container. No API, web, identity provider, broker, telemetry collector or model service |
| `.github/workflows/ci.yml` | Lint, typecheck, unit coverage, web Playwright tests, PostgreSQL integration tests (service container), build, `git diff --check` | Real PostgreSQL in CI. No compose-based end-to-end run |
| `apps/api/src/auth/config.ts` | Issuer and audience configuration for an external provider (Auth0 pattern) | Validated configuration only. No local OIDC provider exists |
| `apps/api/src/auth/test-authentication.ts` | RS256 test signing through the production verifier | Test-only. Not a runtime identity service |
| `infra/terraform/auth0/` | Auth0 Terraform, reconciliation and preflight scripts with tests | Live-facing identity configuration. **Not to be modified** without approval |
| `infra/terraform/aws/` | AWS Terraform scaffold (`main.tf`, `variables.tf`, README) | Scaffold. Not applied anywhere in this assessment. Not verified |
| `scripts/setup-auth0-env.mjs` | Auth0 environment helper | Live-facing. Not run |
| Ollama usage | `retrieval/ollama-embeddings.ts` (`nomic-embed-text`), `rag/ollama-generator.ts` (`qwen2.5:3b-instruct`, digest-pinned), reranker and reformulator | Loopback Ollama client code with pinned model names. No container or documented local service. Live inference requires separate authorisation under the standing rules |
| OpenTelemetry | No OpenTelemetry SDK dependency. `observability/tracing.ts` is a hand-written OTLP/HTTP JSON exporter, loopback only | Not standards-compliant instrumentation in the OTel sense. No collector exists |
| Message broker | None | Not present. Not required by the current design (see section 3) |
| Workload identity | None | Not present. C8 identities are configuration strings |
| Kubernetes | None | Not present. No concrete requirement yet (see section 3) |

### 1.3 Durable state (verified in migrations)

Migrations 001–013 exist. Tables of note: `tenants`, `memberships`, `support_cases`, `audit_events`, `documents`, `document_chunks`, `chunk_embeddings`, `tool_approvals` (007), `workflow_executions` and `workflow_checkpoints` (008, with leases and version), `rate_limit_buckets` (013, forced RLS). Row-level security is enforced through `aegis.tenant_id` and membership snapshots.

Not present: persisted agent executions beyond the workflow tables, persisted grants, persisted delegation chains, persisted agent registrations, a durable message queue, and any recovery state for multi-agent runs.

### 1.4 Requirements register (`docs/ENTERPRISE-REQUIREMENTS-REGISTER.md`)

| ID | Register status | Local production-readiness assessment |
| --- | --- | --- |
| C1 | PARTIAL | Engine exists and is behind a disabled flag. Not wired to an end-to-end path. Tokenizer approximate |
| C2 | PARTIAL | Lexical, pgvector and fusion code exist, with measured results. Latency measured on synthetic data. No production-scale corpus |
| C3 | MISSING | Not started |
| C4 | PARTIAL | Answer loop and route exist, development only. Answer quality not independently validated. Live model not approved for production |
| C5 | PARTIAL | Durable driver, leases, checkpoints, approval gates and observability exist with real PostgreSQL tests. Not wired to a deployed worker process. Crash recovery is tested by simulating a lost attempt inside one test process; no separate worker process has been killed and recovered |
| C6 | PARTIAL | MCP stdio server, gateway, admission, gate. Real SDK client tests. Independent review pending. No HTTP transport (deliberately) |
| C7 | MISSING | Not started |
| C8 | MISSING | Pure design and 33 deterministic tests (PR #77). No runtime, no persistence, no workload identity |
| C9 | PARTIAL | Deterministic gates v1–v3 and a durable integration test. CI gate verification on the exact PR head not done |
| C10 | PARTIAL | Gateway with deny-by-default, approvals, rate limit, verified identity boundary. One read-only tool path plus MCP. Independent review not done |
| C11 | MISSING | Not started |
| C12 | PARTIAL | Documentation exists. Teardown not final |
| L1–L6 | MISSING | No SLIs, FinOps, capacity, governance, operating model or strategy artefacts beyond the register text |

## 2. Gap analysis against the production-local directive

| Directive requirement | Current state | Gap | Local-real option |
| --- | --- | --- | --- |
| Containerised API and web | Not containerised | Build and run image, healthcheck | Dockerfile per app; compose service |
| Real PostgreSQL, pgvector, RLS, migrations | Met | Automated migration job in compose; app role provisioning | Existing `migrateDatabase` as a one-shot service |
| Standards-compliant local OIDC provider | Missing (Auth0 only, live) | A local OIDC issuer for development identities, with JWKS, token issuance and expiry | Keycloak or Dex in compose (decision D1) |
| Workload identity for separate agent services | Missing | Attestable per-workload identities with short-lived SVIDs | SPIFFE/SPIRE server and agent in compose (decision D2) |
| mTLS or mutually authenticated service calls | Missing | Local CA, certificate issuance, rotation | SPIRE-issued X.509 SVIDs over mTLS |
| Credential issuance, expiry and rotation | Missing (env var bearer token) | Automated short-lived credentials | SPIRE rotation; OIDC token lifetimes |
| Message broker or durable transport | Missing | Agent messages must be durable and exactly-once-effective | PostgreSQL transactional outbox and `SKIP LOCKED` queue (decision D3) |
| Persistent executions, checkpoints, grants, approvals, recovery | Partly met (workflow, approvals) | Grants, delegation chains, agent registrations, recovery of multi-agent runs | New migrations 014+ with RLS |
| MCP over supported transports | stdio only | Streamable HTTP is not implemented. Deliberately deferred | Keep stdio local; HTTP needs approval (decision D5) |
| OpenTelemetry tracing, metrics, structured logs | Hand-written exporter | Real OTel SDK and a local collector | OTel SDK plus `otel-collector` container (decision D4) |
| Local model serving via Ollama, provider abstraction | Client code exists, no service | Provider interface, container, approved model list | Ollama container; model calls only with approval (see 4.6) |
| Health, readiness, reproducible startup | `GET /api/health` exists as a static starter response (see section 8); no readiness check; Postgres healthcheck only | Liveness and readiness endpoints; one-command startup | Compose with healthchecks and `depends_on` conditions |
| Secure local security and integration test environment | CI service container | Compose-based environment for E2E and security tests | Same compose file used by tests |

## 3. Components evaluated and deferred

| Component | Decision | Reason |
| --- | --- | --- |
| Kubernetes | Defer | No concrete requirement yet. Compose reproduces the components and their healthchecks. Reconsider when there are several independently scaled services or a deployment target that requires it. Requires an approved decision before any cluster is created |
| Redis | Not adopted | No cache or rate-limit requirement that PostgreSQL does not already meet. C11 semantic cache needs a measured requirement first |
| Kafka | Not adopted | Message volume and retention needs are not established. PostgreSQL outbox is transactional with the state it describes, which a separate broker would have to re-synchronise |
| Vault | Defer | SPIRE handles workload credentials. Human and provider secrets remain in local environment files that are git-ignored, with rotation procedures. Vault becomes justified with multiple secret consumers and audited dynamic secrets |
| SPIRE | Adopt (decision D2) | Separately deployed agent workloads need attestable identity and short-lived credentials. Nothing else in the stack provides this |

## 4. Dependency-ordered plan

Each step lists its dependencies, the work, and measurable acceptance criteria. Steps are ordered by dependency, not by ease.

### 4.1 Step P1: containerised local platform

- **Depends on:** nothing.
- **Work:** Dockerfiles for the API and the web application. Compose services for the API, the web application, a one-shot migration job, and healthchecks. Environment files with generated local passwords (never committed). A single documented start command.
- **Acceptance:**
  - `docker compose up` on a clean machine reaches all services healthy, with no manual steps beyond creating the environment file.
  - `GET /api/health` (liveness, no dependencies) and `GET /api/ready` (readiness: database reachable and every migration applied) return correct status, including when the database is stopped.
  - The migration job is idempotent when run twice.
  - No port is bound beyond 127.0.0.1.
- **Evidence to record:** command transcript, `docker compose ps` health table, and a test that stops PostgreSQL and checks readiness goes false.

### 4.2 Step P2: local OIDC identity provider

- **Depends on:** P1.
- **Work:** Add a standards-compliant local OIDC issuer for development identities (decision D1). Configure a development realm with two test users, one per tenant, with membership in the database. Wire the API's verifier to the local issuer's JWKS, through configuration only.
- **Acceptance:**
  - A real authorization-code flow (PKCE) or client-credentials token is obtained from the local issuer and accepted by the production verifier.
  - Forged, expired, wrong-audience and wrong-issuer tokens are refused by the same verifier.
  - Token lifetime and rotation of the signing key are exercised: a key rotation takes effect without restarting the API within the JWKS cache interval.
  - The Auth0 Terraform and scripts are unchanged (checked by diff).
- **Real versus simulated:** the issuer and its JWKS are real. Development users and the realm are synthetic.

### 4.3 Step P3: workload identity and mTLS (SPIRE)

- **Depends on:** P1. Decision D2 approved.
- **Work:** SPIRE server and agent in compose. A workload registration for each agent service with attestation (Docker workload attestor). X.509 SVIDs issued to each agent. mTLS between agent services with SPIFFE ID checks on each peer.
- **Acceptance:**
  - Each agent receives an SVID whose SPIFFE ID encodes its registration. Only the registered workload obtains it.
  - A second process without the registration is refused an SVID.
  - Peer calls succeed with the correct SPIFFE ID and fail with a wrong ID, an expired certificate, or no certificate.
  - SVID rotation occurs before expiry, with a short TTL, and a workload restart renews it.
  - Impersonation test: a process presenting another agent's certificate is refused.
- **Real versus simulated:** SPIRE and certificates are real. The attestation uses the local Docker runtime.

### 4.4 Step P4: durable orchestration persistence (C5 integration, C8 foundation)

- **Depends on:** P1, and C5 and C8 branches as reviewed.
- **Work:** Migrations 014+ for agent registrations, executions, delegation chains, grants (with status, expiry and consumption record), and an orchestrator-owned execution context. Row-level security on every table. Atomic grant consumption (`UPDATE ... WHERE status = 'open' RETURNING`), optimistic concurrency via a version column, and lease-based ownership with fencing tokens. Global counters for delegations and steps stored per execution and updated in the same transaction as the decision.
- **Acceptance:**
  - Concurrent consumption of one grant from ten connections yields exactly one success.
  - A global delegation budget shared by two worker processes is never exceeded (concurrency test with real PostgreSQL).
  - A crashed worker's lease is reclaimed after expiry; a stale worker's late write is rejected by the fencing token.
  - Cross-tenant reads and writes of every new table are refused by RLS.
  - Migration rollback is not required; migrations are additive and tested on a fresh database and on the previous schema.

### 4.5 Step P5: durable message transport (transactional outbox)

- **Depends on:** P4.
- **Work:** Agent-to-agent messages written to an outbox table in the same transaction as the decision that produces them. A dispatcher claims rows with `FOR UPDATE SKIP LOCKED`, delivers over the mTLS channel from P3, and marks them delivered only after the receiver acknowledges. Receivers record message ids to deduplicate.
- **Acceptance:**
  - Duplicate delivery (a dispatcher crash after send, before acknowledgement) results in one effect, verified by the receiver's dedup table.
  - A receiver outage causes retry with backoff, then dead-lettering after the configured count, with each step audited.
  - Network interruption (killed connection mid-message) leaves the message pending and it is delivered exactly once in effect.

### 4.6 Step P6: model provider interface and local Ollama

- **Depends on:** P1. Each live inference call needs separate authorisation under the standing rules.
- **Work:** A provider interface with the Ollama implementation behind it. Ollama runs as a compose service on the loopback network, with pinned model digests. Deterministic fake provider for unit and integration tests. A health check that verifies the pinned digest.
- **Acceptance:**
  - Without authorisation, the test suite uses the deterministic provider only (enforced by a test that fails if the live provider is selected in CI).
  - With authorisation for one bounded run, the pinned model returns a response and the provider records latency and token counts.
  - Digest mismatch is refused.
- **Blocked on:** approval for live inference (decision D6).

### 4.7 Step P7: observability

- **Depends on:** P1.
- **Work:** Replace the hand-written OTLP exporter with the OpenTelemetry SDK, exporting to an `otel-collector` container. Structured JSON logs carrying trace and span ids. Metrics for admission, gateway decisions, leases, delegation refusals and outbox lag.
- **Acceptance:**
  - A tenant-scoped request produces a trace spanning API, gateway, database and agent calls, visible in the collector's output.
  - Attribute allowlist test: no subject, token, query text or argument value is exported.
  - Metric values match counted operations in a test run.

### 4.8 Step P8: first working multi-agent use case (read-only)

- **Depends on:** P2, P3, P4, P5, P7 and C6/C8 as reviewed.
- **Work:** Investigation workflow: verified principal submits a request; orchestrator creates a durable execution; triage agent plans; retrieval agent obtains tenant-authorised evidence through the gateway; reviewer agent checks the result against the evidence; orchestrator returns a traceable, schema-validated result. Deterministic agents first. Model-backed agents only after P6 authorisation.
- **Acceptance:**
  - End-to-end test through the real API, real identity token, real SPIRE-identified agents, real PostgreSQL, and real message transport. Result matches a schema and cites only tenant-authorised evidence.
  - Cross-tenant evidence is never returned, even when the retrieval agent is asked for it (adversarial test).
  - Killing the retrieval agent mid-run and restarting it results in a recovered, single, correct result.
  - Trace shows each hop with the correct SPIFFE ID and delegation chain.

### 4.9 Step P9: security, reliability and performance evidence

- **Depends on:** P8.
- **Work:** Adversarial suite (forgery, impersonation, cross-tenant, scope escalation, malicious arguments, replay, unauthorised tool calls, secret exposure, privilege bypass), reliability suite (crash, duplicate delivery, retry exhaustion, lease expiry, network interruption, restart, dependency outage, credential expiry, partial commit), and performance measurements (p50 and p95 latency, throughput, saturation, query plans).
- **Acceptance:** each category has tests that run locally in one command, with recorded results and no skipped cases without a reason.

### 4.10 Remaining register items

After P1–P9, the register items are taken in dependency order: C5 wiring to the deployed worker (depends on P4), C10 rate-limit and approval reviews (independent), C9 gates on the exact PR head (CI), C2 and C1 wiring into the workflow behind flags, C7 memory tiers (needs a privacy design decision), C11 caching and routing (needs measurements first), C3 GraphRAG (needs C2 comparative evidence), and L1–L6 operational artefacts (SLIs need P7 telemetry).

## 5. Acceptance evidence required for every capability

For each capability the record must state: what is implemented in production-intended code; what runs locally; which dependencies are real and which are simulated; which security boundaries are enforced; test names and counts with the commit; whether end-to-end operation was demonstrated; performance and reliability evidence; what remains unverified; what needs independent review; and what would change by configuration rather than code when promoted.

## 6. Decisions requiring your approval

- **D1 Local OIDC provider.** Keycloak (full-featured, heavier) or Dex (lighter, OIDC connector model). Either runs locally only. Recommendation: Keycloak, because it provides user management, token lifetimes and key rotation needed for P2 without custom code. Requires approval because it adds container images from a third-party registry.
- **D2 SPIRE.** Recommendation: adopt, because it is the only production-equivalent way to give separately deployed agents attestable identities. Requires approval because it adds images and a trust domain. The trust domain is local (`aegis.local`); no federation with external systems.
- **D3 PostgreSQL outbox instead of a broker.** Recommendation: adopt. Requires no new infrastructure. Revisit when throughput or fan-out is measured as a problem.
- **D4 OpenTelemetry collector.** Recommendation: adopt, since the hand-written exporter is not standards-compliant. Requires approval for the collector image.
- **D5 MCP HTTP transport.** Not planned in this sequence. Adding it exposes a network surface and needs its own threat model and approval.
- **D6 Live model inference.** Each run requires explicit authorisation under the standing rules. The plan does not start live inference.
- **D7 Kubernetes.** Deferred. Creating a cluster needs approval.
- **D8 Auth0 and AWS Terraform.** Not modified. Any change to live identity configuration or to AWS resources needs approval.
- **D9 Pulling third-party images.** Compose and SPIRE need images from registries. Approval requested in one batch with D1, D2 and D4.

## 7. What this plan does not claim

- No capability is complete or production-qualified.
- C6 remains PARTIAL and its independent review is pending.
- C8 remains MISSING. Its design (PR #77) is not runtime evidence.
- Nothing in this plan merges, deploys or changes live identity or cloud configuration.
- The current repository has no workload identity, no OpenTelemetry instrumentation, no broker and no containerised application. These are gaps, not design choices already made.

## 8. Corrections from review (2026-11-21)

These findings correct sections 1 to 4 and are binding on the implementation.

1. **Health route.** `GET /api/health` already exists (`apps/api/src/app.ts`). It returns a static starter response that does not touch the database. It is kept as the liveness endpoint. A separate `GET /api/ready` will check database reachability and that every migration in `db/migrations` is recorded in `aegis_migrations.versions`. The plan does not claim that no health route exists.
2. **Issuer validation.** `validateIssuer` currently requires HTTPS, an origin-only URL with no path, and no port. An OIDC issuer identifier is a URL that may include a path (Keycloak issues realm-specific issuers such as `https://host/realms/<realm>`), and may include a port. The verifier also derives the JWKS URL as `issuer + /.well-known/jwks.json`, which is not where Keycloak publishes keys. The implementation will (a) validate issuers against the OIDC rules (scheme, no userinfo, query or fragment, exact string match against the `iss` claim), (b) resolve keys through OIDC discovery (`.well-known/openid-configuration`), checking that the discovered `issuer` equals the configured issuer, with an explicit JWKS URL as an override for container networks, and (c) keep production strict: HTTPS only. Plain HTTP is accepted only when `AEGIS_ENVIRONMENT=local` and the host is loopback or a named local service. Signature, algorithm (RS256), issuer, audience and expiry checks are unchanged.
3. **Web authentication.** `apps/web` uses `@auth0/auth0-react` (`DevAuthExperience.tsx`). Provider-neutral OIDC needs an authorization-code flow with PKCE, token storage policy, silent renewal and logout handling. The proposed replacement is `oidc-client-ts` with `react-oidc-context`, which work with any compliant issuer, including Keycloak locally and a managed identity platform later. Only the issuer, client id and audience move into configuration. No authentication bypass is introduced; the development sign-in path must go through the same provider. This migration is a separate step after P2 backend verification.
4. **Bind address.** `apps/api/src/server.ts` listens on `127.0.0.1` only. Inside a container that is unreachable from other services. The host will come from `AEGIS_API_HOST`. The default stays `127.0.0.1`. The container sets `0.0.0.0` inside its own network namespace. Compose publishes the host port only on `127.0.0.1`, so the API is reachable from the host loopback and from named services only.
5. **Branch relationships.** This plan is on `production-local-plan` (from C10 base, `ff7156e`). It does not include C6 (PR #76, head `c90b26a`) or C8 (PR #77, head `08c305f`). The implementation of P1 and P2 is on `local-platform-p1`, created from `production-local-plan`. Neither C6 nor C8 is merged into it. C6 and C8 remain as separate draft or ready PRs against C10.

Additional constraints recorded from the approval:
- Database host guard: `localDatabaseUrl` accepts only loopback hosts today. Containers need a named service host. The rule becomes: loopback is always allowed; another host is allowed only when `AEGIS_ENVIRONMENT=local` and the host is listed in `AEGIS_ALLOWED_DATABASE_HOSTS`.
- The migration job is a separate, development-only role (`requireDevelopment`). The API container runs with `NODE_ENV=production`.
- Images are official and pinned by digest: `node@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54` (node 24 bookworm slim, arm64 verified) and `nginx@sha256:65645c7bb6a0661892a8b03b89d0743208a18dd2f3f17a54ef4b76fb8e2f2a10` (nginx 1.27 alpine, arm64 verified).
- The existing containers (`agentic-rag-chatbot-postgres-1`, `local-ai-assistant-searxng-1`, `ragverify-postgres-1`, and the exited `aegis-ai-portfolio-git-postgres-1`) are not stopped, reused or removed. The compose project is `aegis-local`, with its own network and volume.

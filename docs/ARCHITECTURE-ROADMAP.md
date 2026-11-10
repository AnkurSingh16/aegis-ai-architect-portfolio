# Aegis AI — implementation roadmap

## Goal
Demonstrate enterprise-ready systems thinking: multi-tenant support copilot, sourced answers, secure IAM/CIAM, approved escalation actions, observable and cost-aware operations.

## Now (starter)
- React/Vite portfolio page, Node/Fastify health + **synthetic** demo response.
- Independent architect/challenger review roles; QA/security/release agents.
- Unit/component tests with published HTML coverage artifacts and GitHub CI.
- Example private S3 Terraform template; **no provisioning**.

## Milestone 2A — local persistent multi-tenant case foundation

- Existing PostgreSQL 17 Compose service stores synthetic tenants, support cases and append-only case-change audits.
- Versioned checksum-verified SQL migrations use separate administrator credentials; runtime uses a nonowner `NOSUPERUSER NOBYPASSRLS` role with no role memberships or administrative privileges.
- Forced, default-deny RLS applies to every tenant-bearing table. One checked-out connection and transaction-local tenant context scope each operation; atomic database triggers record case changes.
- A local CLI supports create/list/read/status-update/audit and stored-case synthetic triage. Server-owned `north`/`south` fixture configuration is the only tenant selector. There are no storage HTTP endpoints; arbitrary browser tenant IDs never authorize access.
- Real PostgreSQL integration tests and an isolated CI service verify cross-tenant reads/writes, missing/malformed context, role privileges, rollback, pool reuse and concurrent transactions. Unit/component coverage measures the non-database workflow separately.
- Existing browser triage remains stateless and explicitly synthetic. No real AI, production authentication, public write API or cloud deployment is introduced.

See [ADR 002](adr/002-local-multitenant-case-storage.md) and the [README runbook](../README.md). Runtime credentials can choose tenant context and therefore remain a trusted-server credential, not proof of an end user's tenant identity. Production identity is the next authorization boundary.

## Milestone 2B — local Auth0 identity and tenant authorization

- Optional Auth0 OIDC access-token verification uses a configured HTTPS issuer, issuer-derived JWKS, RS256 only, exact issuer/API audience, required subject and expiry, and standard not-before validation when present. Only signed `scope` values authorize API permissions; role and permissions claims do not replace database authorization.
- Server-side memberships bind verified issuer/subject to a tenant and `reader`/`operator` role. The required scope and membership role must both permit an operation. A tenant path value selects the membership to check but is not proof of access.
- Versioned migration 002 adds a forced-RLS membership table, SELECT-only membership access for `aegis_app`, and authenticated-principal checks to tenant/case/audit policies. Each request resolves membership and performs work in one repeatable-read transaction with transaction-local principal and tenant context.
- A local administrator-only CLI provisions memberships. Existing synthetic triage remains unchanged. Auth0 dashboard setup is manual; there is no browser login, cloud setup, real LLM call or production deployment.
- Unit tests use generated local signing keys; integration tests verify authentication through PostgreSQL RLS using the isolated local test database.

See [ADR 003](adr/003-auth0-tenant-authorization.md), the [security runbook](SECURITY-RUNBOOK.md), and [README setup](../README.md#auth0-protected-case-api-milestone-2b). Membership revocation applies to new transactions after commit; an in-flight repeatable-read request can complete from its snapshot. Existing case-change audit rows lack authenticated actor attribution.

## Milestone 2C — Auth0 Terraform foundation

- A separately scoped Terraform root pins the official Auth0 provider and declares the Aegis API, individual `read:cases` and `write:cases` scopes, a public loopback-only SPA using Authorization Code + PKCE, and association with one explicitly supplied existing database connection.
- Tenant-wide settings, the provisioner M2M app, existing connection configuration, Auth0 roles, PostgreSQL roles, and cloud resources remain unmanaged. PostgreSQL remains authoritative for `reader` and `operator` memberships; the existing JWT and RLS checks remain required.
- A hidden-input local setup helper creates a mode-0600 ignored Management API credential file. HCP Terraform Free stores remote state in the dedicated `aegis-auth0-dev` workspace while Terraform executes locally. A read-only preflight checks the organization plan, workspace execution mode, auto-apply setting and empty initial state before initialization. The restricted local wrapper permits only `fmt`, authenticated `init`, `validate`, and unsaved `plan`; no automatic or wrapper-driven apply/destroy exists. GitHub CI keeps backend-disabled initialization and validates syntax/provider schema without live credentials or HCP access.
- A loopback PKCE smoke harness exercises one real-token case-list request without persisting or displaying a bearer token. It complements, but does not replace, synthetic-key integration tests.
- A separate local first-deployment gate may apply only a privately saved, integrity-checked plan containing exactly five create-only actions after repeated HCP/Auth0 checks and typed TTY authorization. The regular wrapper remains read-only. Partial failures require manual state and Auth0 inventory review; success requires manual state-marker binding and a no-op plan. Tests mock all external operations and never execute apply.

See [ADR 004](adr/004-auth0-terraform-foundation.md) and [the Auth0 security runbook](SECURITY-RUNBOOK.md).

## Milestone 3A — authenticated AI-assisted case intelligence

- A development-only `POST /api/tenants/:tenantId/cases/:caseId/ai-analysis` route reuses RS256 token verification, `read:cases`, database membership and forced RLS. It reads the authorized stored row in the existing repeatable-read transaction, releases the connection, then performs inference; rejected requests never invoke the provider.
- The first provider is optional Ollama at the fixed loopback endpoint. It is disabled by default, requires an explicit server-side development opt-in, has no cloud fallback or model download path, and bounds concurrency, request/response size, generation, and duration.
- The database row contains a synthetic case ID/status/timestamps, not a narrative. The prompt uses that authorized row plus the source-controlled synthetic fixture catalog; browser-supplied case text is rejected. Output is strict JSON with allowlisted categories, priorities, teams, next actions and references to case fields. These references are not RAG citations or external grounding.
- UI analysis is read-only, authenticated, cancellation-aware, and clears stale results across tenant, case, identity and session changes. All recommendations require human review; no status update, communication, or escalation is performed.
- Deterministic evaluation tests measure contract and fixture behavior only. Real inference and model quality have not been evaluated. Synthetic fixtures and mocked provider endpoints keep CI offline.

See [ADR 006](adr/006-local-ai-case-intelligence.md), the [README local inference guide](../README.md#ai-assisted-case-intelligence-milestone-3a), and [security runbook](SECURITY-RUNBOOK.md).

### Milestone 3B — bounded local-model evaluation and reliability

- A versioned, source-controlled synthetic evaluation corpus separates three canonical case types, predeclared engineering-reviewed expected labels, fixed UTC timestamp variants, and deterministic output-contract probes. It is not a production fixture catalog and its labels are not human-approved.
- A deterministic scorer reports schema/evidence contract outcomes, label agreement by field, human-review enforcement, rejection reasons, latency and available token metrics with explicit denominators. Contract compliance is not model accuracy; six provider-level observations are a reproducible smoke evaluation, not a statistically reliable estimate.
- The optional local evaluation runner uses only the existing bounded Ollama provider and in-memory synthetic `StoredCase` values. It has six statically declared sequential slots (two per case type), no retry or replacement path, sanitized one-time reporting, and no database or authenticated HTTP access. Ordinary tests and CI remain provider-mocked and offline.
- Reliability work is limited to defects demonstrated by the evaluation; existing Auth0, membership, forced RLS, request correlation, schema validation and human-review boundaries remain authoritative.

**Execution status (2026-11-09):** The deterministic framework and private report protections are implemented. After fixing a preflight false rejection of the harness's own loopback health socket, one separately authorized bounded run completed **6/6 planned provider-level attempts** with 6 successes, no failures and no unattempted slots. JSON parsing, strict schema acceptance, evidence-reference compliance, category, team, action, human-review and provider-event correlation each measured 6/6. Priority exact-match was 2/6: both billing observations were high rather than the predeclared medium, and both guidance observations were medium rather than the predeclared low. These labels are engineering-reviewed, not human-approved. The timestamp pairs are not independent cases; six calls over three synthetic types are not production accuracy evidence. See the [sanitized evaluation summary](AI-EVALUATION-3B.16.md). Milestone 3B.16 is **completed as a bounded smoke evaluation**, not as model qualification or production readiness.

See [ADR 007](adr/007-tenant-scoped-grounded-case-intelligence.md) and [ADR 008](adr/008-grounded-document-ingestion-and-retrieval.md) for the accepted local-first architecture and implementation choices.

## Milestone 4 — tenant-scoped, evidence-grounded case intelligence

**Status: implementation merged and local synthetic rollout completed; full demo acceptance is incomplete.** Main includes the local-first implementation. The reported rollout applied migrations 004/005 to `aegis_local`, ingested the synthetic corpus, and verified retrieval and runtime readiness. Main CI is green. No cloud provider, paid service, additional model, data egress, or production infrastructure is approved.

Implemented baseline: versioned synthetic source catalog and restricted ingestion; tenant-owned forced-RLS storage; bounded PostgreSQL English full-text retrieval; authenticated case/membership transaction boundary; request-scoped citation IDs and exact validation; strict supported/abstention contracts; mocked security/retrieval tests; local-only provider and development UI. Recommendations remain advisory and no action executes. Retrieval checks were reported in the private rollout record; semantic groundedness is not proven by citation identity.

**Engineering entry criteria:** ADR, synthetic corpus, schema/RLS design, local-first provider boundary, deterministic isolated PostgreSQL tests, and bounded evaluation are implemented and CI-verified. **Remaining acceptance gates:** actual Auth0 browser-authenticated HTTP verification and a successful reviewed grounded-model evaluation. Any cloud provider requires separate approval for data egress, retention, regional processing, secrets and cost.

**Residual risks:** retrieval relevance, citation spoofing, malicious source text, stale chunks, model hallucination and local resource limits. The implementation sequence is complete through local rollout; model qualification and actual authenticated HTTP evidence remain pending. Milestone 4 is not production-ready.

**Milestone 4.1 storage foundation (merged and locally migrated):** tenant-owned `aegis.documents` and `aegis.document_chunks` use version/provenance/integrity constraints, forced-RLS read policies, least-privilege runtime verification, and isolated `aegis_test` security coverage. The local rollout report records migrations 001–005 applied to the Docker Desktop `aegis_local` instance under separate operator authorization.

**Milestone 4 implementation (merged):** the synthetic-only vertical slice includes additive migrations 004/005, eight versioned synthetic documents, deterministic chunking, separate restricted ingestion, bounded English full-text retrieval, authenticated grounded analysis, request-scoped citations, strict abstention/output contracts, a development UI, and deterministic retrieval/security tests. `aegis_app` remains SELECT-only.

**Acceptance evidence and limitations (2026-11-10):** main CI run `42798430560` passed all required gates. The private local rollout report records successful migration, ingestion, integrity, tenant-isolation, FTS, API-health, and unauthenticated-boundary checks. Actual Auth0 browser-authenticated HTTP smoke remains unverified. The private grounded provider report records six parsed JSON outputs, zero strict-schema acceptances, and six `output_schema` / `invalid_output` failures; citation and classification measures were therefore not measured. No rejected values were retained, so the precise failed predicate is unknown. A follow-up deterministic diagnostic change and separately authorized v2 evaluation are required before model-quality acceptance. Prior Milestone 3B priority agreement remains 2/6. Milestone 4 is not production-ready. The 4.2–4.6 labels describe the implementation decomposition, not previously defined normative scopes.

## Vertical slice 3 — human approved actions
- Proposed support escalation action; approval policy; idempotency and audit trail.
- Explicit two-step approve/execute flow with role checks and rollback plan.

## Vertical slice 4 — hardening and hosting
- CI quality gates: unit, integration (DB), Playwright E2E and dependency scanning.
- Observability/OpenTelemetry, SLO dashboards, WAF, rate limits and failure drills.
- Dedicated staging/prod, environment-scoped GitHub permissions, OpenID Connect to cloud.
- Deploy portfolio to static hosting, API/data tier to reviewed infrastructure.
- Optional React Native Expo app sharing API contracts; iOS simulator first.

## Role demonstration evidence
Every milestone should capture ADR, threat model, test + coverage report, cost estimate, runbook, demo GIF/screenshot (sanitized), dashboard and measurable before/after outcomes. Never represent starter mocks as completed production capabilities.

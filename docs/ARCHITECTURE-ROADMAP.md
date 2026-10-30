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

## Vertical slice 1 — actual product foundations
- PostgreSQL tables for tenants, users, documents, audit events; deny cross-tenant queries.
- Measured AI and retrieval, building on the local Auth0/JWT and tenant-membership foundation in Milestone 2B.
- Tests for unauthorized access, incorrect audiences, expired tokens and cross-tenant IDs.

## Vertical slice 2 — measured AI
- OpenAI Responses API server-side only (key in environment/secret manager).
- Retrieval from pgvector with signed source/document ownership checks.
- Citation validation, groundedness eval dataset (synthetic only), cost/latency measurement.
- Prompt-injection guards and refusal for data outside authorized tenant.

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

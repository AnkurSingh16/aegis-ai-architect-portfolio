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

## Vertical slice 1 — actual product foundations
- PostgreSQL tables for tenants, users, documents, audit events; deny cross-tenant queries.
- Real JWT issuer, audience, JWKS signature, expiry and scope validation (Auth0).
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

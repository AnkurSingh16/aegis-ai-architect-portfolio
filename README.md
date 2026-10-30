# Aegis AI — Enterprise AI Engineering Portfolio

An educational, production-minded portfolio foundation built with Node.js, TypeScript, React, Codex subagents, tests, CI and infrastructure-as-code planning.

> **Status:** Milestones 2A and 2B provide local PostgreSQL case storage, database-enforced tenant isolation, and an optional Auth0 access-token boundary for protected case APIs. This remains a synthetic demonstration, **not** a production-ready AI service. Browser triage returns fixed mock responses; no OpenAI API, RAG, cloud deployment or production identity operations are included.

## Start on an Apple Silicon Mac

See **[docs/MAC-SETUP.md](docs/MAC-SETUP.md)** first. The short path, once Node 24 LTS and GitHub are configured:

```bash
npm install
npm run dev
```

Open http://localhost:5173 in your browser. API health is at http://localhost:4000/api/health.

## Synthetic support triage

In the **Customer support case triage** section, choose a supplied synthetic case and select **Triage synthetic case**. React sends its allowlisted ID to Fastify, then displays category, priority, suggested team, rationale and a suggested next step. Changing cases clears the previous result. Failed requests can be retried; requests time out after ten seconds.

| Invented case | Category | Priority | Suggested team |
| --- | --- | --- | --- |
| Login outage | incident | high | Platform support |
| Duplicate invoice | billing | medium | Billing support |
| Documentation request | guidance | low | Customer support |

These are fixed fixture lookups, **not LLM inference or RAG**. The browser workflow stores nothing and accepts no customer text. Nothing is sent to a support team, escalated or refunded. It needs no database or paid service. The separate local CLI below persists synthetic case records.

`POST /api/demo/triage` accepts JSON containing exactly one supported case ID:

```json
{"caseId":"SYNTHETIC-LOGIN-001"}
```

The response contract contains `mode: "synthetic-mock"`, the same `caseId`, `category`, `priority`, `suggestedTeam`, `rationale`, `nextStep`, and an explicit synthetic warning. The shared dependency-free contract lives in `apps/api/src/contracts/triage.ts`; the browser validates the result before displaying it. Requests reject extra fields and incorrect types, with a 1 KiB body limit. Errors use stable messages: invalid requests return 400, oversized requests 413, unsupported media types 415, and unexpected failures 500.

**Local development only:** the API and Vite development server bind to loopback. Both demo API routes are absent when `NODE_ENV=production`; production frontend builds display a local-availability message instead of the triage form. Do not expose the unauthenticated development servers through a public proxy or tunnel. The browser workflow has no authentication, persistence, rate limiting or production support workflow. See [the triage design decision](docs/TRIAGE-DEMO-DECISION.md).

## Persistent multi-tenant cases (Milestone 2A)

Storage uses the existing PostgreSQL 17 Compose service and persistent named volume. A local CLI creates cases from the three synthetic fixtures, lists/reads them, updates status, reads audit history and applies the existing mock triage lookup to a stored case. Milestone 2A has no storage HTTP endpoints; Milestone 2B adds the optional protected Auth0 routes described below. Tenant selection for the 2A CLI comes only from an allowlisted server configuration (`AEGIS_DEV_FIXTURE=north` or `south`); browser tenant IDs are never used as authorization.

1. Install/start Docker with Compose, then copy `.env.example` to ignored `.env`. Replace password placeholders and use matching, URL-encoded passwords in connection URLs. Keep administrator and runtime passwords separate. For an existing Compose volume, use its existing administrator password: changing environment variables does not rotate an initialized database's password. Never delete the volume to resolve a credential mismatch.
2. Start PostgreSQL and load configuration into each command with Node's environment-file support:

```bash
docker compose up -d --wait postgres
node --env-file=.env --import tsx apps/api/src/storage/migrate-cli.ts
node --env-file=.env --import tsx apps/api/src/storage/cli.ts create SYNTHETIC-LOGIN-001
node --env-file=.env --import tsx apps/api/src/storage/cli.ts list
```

Use the returned UUID in subsequent commands:

```bash
node --env-file=.env --import tsx apps/api/src/storage/cli.ts read <case-uuid>
node --env-file=.env --import tsx apps/api/src/storage/cli.ts update <case-uuid> in_progress
node --env-file=.env --import tsx apps/api/src/storage/cli.ts audit <case-uuid>
node --env-file=.env --import tsx apps/api/src/storage/cli.ts triage <case-uuid>
```

When environment variables are already exported, equivalents are `npm run db:migrate` and `npm run cases -- list` (or another command above). Change `AEGIS_DEV_FIXTURE` in server configuration to inspect the other synthetic tenant; no `--tenant` argument is accepted. Supported statuses are `open`, `in_progress`, and `resolved`. Commands refuse production mode and remote database URLs. Lists and audit history return at most 100 records for this bounded demonstration.

Migrations run transactionally under an advisory lock and record SHA-256 checksums. Applied SQL must remain unchanged; future changes require a new numbered file. The migration command creates `aegis_app` once using `DATABASE_APP_PASSWORD`; replay validates the role but does **not** rotate an existing role's password. Runtime commands connect directly as `aegis_app`, verify its restricted privileges and forced RLS, and fail closed on administrator credentials. Case writes and trigger-generated audit records commit or roll back together. Errors/logs contain stable operation codes and correlation IDs, excluding raw SQL errors, connection URLs and passwords.

RLS protects against omitted tenant filters in trusted server code. The runtime credential can choose the transaction's tenant setting, so possession of that credential is **not** tenant authentication. Keep it private. Database administrators remain trusted and can bypass RLS; administrator-enabled SQL bind-parameter logging may capture bootstrap credentials, so do not enable it for credential setup. Production identity, authorization and deployment are deferred. See [ADR 002](docs/adr/002-local-multitenant-case-storage.md) for the boundary and trade-offs.

## Auth0 protected case API (Milestone 2B)

When `AUTH0_ISSUER` and `AUTH0_AUDIENCE` are configured, the API enables protected `/api/tenants/:tenantId/cases` list, create, read and status-update endpoints. It verifies access-token JWT signatures using issuer-derived JWKS and RS256, exact issuer and API audience, expiry and not-before when present. Requests require the signed `read:cases` or `write:cases` scope. PostgreSQL separately checks that the verified issuer and subject have a membership for the selected tenant and a role that permits the operation. A tenant UUID in the URL only selects which membership to verify. The existing synthetic triage workflow remains unchanged.

### Manual Auth0 setup

1. Create an Auth0 API in your own development tenant with a dedicated API identifier (for example `https://aegis-api.example`). The audience is this identifier, not the SPA application client ID.
2. Enable RBAC for the API and define `read:cases` and `write:cases`. Assign `read:cases` to a `reader` role and both permissions to an `operator` role. Assign a role to a synthetic test user and use an OAuth client that can request the required scopes.
3. Put the tenant's canonical issuer with trailing slash (for example `https://your-tenant.us.auth0.com/`) in `AUTH0_ISSUER`; set `AUTH0_AUDIENCE` to the API identifier. Copy `.env.api.example` to ignored `.env.api` and configure only `DATABASE_URL`, `AUTH0_ISSUER` and `AUTH0_AUDIENCE` there. This runtime-only file keeps administrator credentials out of the HTTP process. Keep Auth0 values out of both example files except for placeholders. Use the restricted `aegis_app` credentials in `DATABASE_URL`.
4. Run migrations. To grant a local tenant membership for the exact Auth0 `sub` claim, set `AEGIS_MEMBER_SUBJECT`, `AEGIS_MEMBER_FIXTURE` (`north` or `south`) and `AEGIS_MEMBER_ROLE`, then run `node --env-file=.env --env-file=.env.api --import tsx apps/api/src/auth/membership-cli.ts grant`. To remove access, keep issuer and subject set and run the same command with `revoke`. This local command requires `DATABASE_ADMIN_URL`; the API runtime cannot grant or revoke membership.
5. Obtain an access token using Authorization Code with PKCE in your local OAuth client. Request the API audience and scopes, then send `Authorization: Bearer <access-token>` to the protected API. Do not paste tokens into logs, tickets or shell history. The browser demo does not perform Auth0 login or store tokens.

Run the API with `node --env-file=.env.api --import tsx apps/api/src/server.ts`. Do not launch it with the full `.env`, which contains administrator credentials for local migrations and membership provisioning. With both Auth0 settings absent, protected case routes are not registered; a partial or malformed configuration fails startup. Tests use generated local keys and do not call Auth0. This repository does not provision an Auth0 tenant; dashboard setup and local configuration are manual. See [ADR 003](docs/adr/003-auth0-tenant-authorization.md) and the [security runbook](docs/SECURITY-RUNBOOK.md).

Membership changes take effect for new transactions after commit. An in-flight repeatable-read request can finish using its transaction snapshot. Case-change audit rows record changes but do not attribute them to a verified Auth0 subject. Production deployment, rate limiting, actor-attributed audit events and production identity operations remain future work.

### Real PostgreSQL integration tests

Create the dedicated test database once without resetting the persistent demonstration database:

```bash
docker compose exec postgres createdb -U aegis_local aegis_test
```

Copy the variable names from `.env.example` and set `TEST_DATABASE_ADMIN_URL`, `TEST_DATABASE_URL` and matching `DATABASE_APP_PASSWORD` values only in your ignored `.env` or exported shell environment. Keep `.env.example` values as placeholders. The tests migrate `aegis_test`, use the restricted runtime role and isolate their fixtures; they refuse the demo database. Run with exported environment variables using `npm run test:integration`, or:

```bash
node --env-file=.env node_modules/vitest/vitest.mjs run --root apps/api --config vitest.integration.config.ts
```

Tests cover cross-tenant reads/writes, absent/malformed context, malformed commands, role restrictions, audit atomicity, pool reuse, rollback and concurrent tenant transactions. GitHub CI uses a fresh PostgreSQL 17 service and isolated `aegis_test` database with disposable CI-only credentials. Unit/component coverage remains available through `npm run test:coverage`; database integration is a separate mandatory gate, not a mocked substitute.

```bash
npm run lint
npm run typecheck
npm run test:coverage
npm run build
```

Open `apps/api/coverage/index.html` and `apps/web/coverage/index.html` for HTML coverage reports after running tests. Generated results are deliberately ignored by Git. Run Auth0 and storage PostgreSQL integration tests against the dedicated test DB with `npm run test:integration -w apps/api`; they do not call Auth0.

## What's included
- `apps/web`: React + Vite portfolio frontend, proxied to local API.
- `apps/api`: Fastify synthetic demo plus local PostgreSQL case CLI, migrations and RLS policies.
- `docs/REACT-NATIVE-SETUP.md`: instructions for a future Expo / React Native app (not initialized yet).
- `.codex/agents`: architect, challenger, implementer, QA, security and release custom subagents.
- `.github/workflows/ci.yml`: lint, typecheck, tests, coverage upload, builds.
- `infra/terraform/aws`: draft non-applied Terraform infrastructure module.
- `docs`: decisions, local setup, release and architecture roadmap.

## Design principles
- Secure-by-default; never commit `.env` files, credentials or customer data.
- Design and skepticism before nontrivial changes; tests/reviews after changes.
- Use feature branches and pull requests; GitHub Actions gates quality.
- Do not deploy mock endpoints as if they were authenticated AI services.
- Add infrastructure only after cost review and explicit human approval.

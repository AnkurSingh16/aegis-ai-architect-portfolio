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
2. Define `read:cases` and `write:cases` permissions for the API. Request the needed permissions from the local SPA using Authorization Code + PKCE. Auth0 roles are not required for this Free-plan demonstration: `reader` and `operator` are PostgreSQL membership roles, and the API does not trust token role claims for database authorization.
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

## Auth0 Terraform foundation (Milestone 2C)

The isolated `infra/terraform/auth0` configuration declares one Case API, its two individual scopes, a public local SPA using Authorization Code + PKCE, and an append-only association with one existing database connection. The config pins the official Auth0 Terraform provider. It does not manage the provisioner M2M app, tenant-wide settings, connection credentials, Auth0 roles, PostgreSQL roles, or cloud infrastructure. `reader` and `operator` remain database membership roles; API access still requires the signed scopes and server-verified database membership from Milestone 2B.

Create the local Management API credential file in an interactive VS Code terminal. Do not paste these values into chat or shell commands:

```bash
node scripts/setup-auth0-env.mjs
```

The helper prompts for the tenant domain and provisioner client ID and hides the client-secret input. It exclusively creates ignored `.env.auth0` with file mode `0600`; it refuses to overwrite an existing file. This file is separate from root `.env` and the PostgreSQL administrator credentials. If a command runner has no interactive terminal, run the command above in the normal VS Code Terminal. Check only file presence and permissions; do not print its contents.

Copy `infra/terraform/auth0/terraform.tfvars.example` to `infra/terraform/auth0/terraform.tfvars` and enter the ID of the existing Auth0 database connection. Then run the credential-isolated wrapper:

```bash
node infra/terraform/auth0/terraform-local.mjs fmt
node infra/terraform/auth0/terraform-local.mjs init
node infra/terraform/auth0/terraform-local.mjs validate
node infra/terraform/auth0/terraform-local.mjs plan
```

The wrapper reads only `AUTH0_DOMAIN`, `AUTH0_CLIENT_ID`, and `AUTH0_CLIENT_SECRET` from `.env.auth0` for `plan`; it does not load root `.env`, inherited database variables, or caller-supplied Terraform arguments. It supports only formatting, initialization, validation, and an unsaved plan. Apply, destroy, import, and state commands are unavailable through this wrapper. The provider requests only the permissions needed for the declared API, scope, client, and one-connection association resources. If the speculative plan reports missing Management API permissions, review the exact missing permission in Auth0 and add it manually only after approval. Do not apply until the plan, import/replacement risks, Auth0 Free-plan compatibility, and state handling have been reviewed.

Terraform validation in GitHub CI downloads the pinned provider and runs format, backend-disabled initialization, and validation without Auth0 or HCP credentials; CI never plans or applies live resources. Terraform uses the HCP Terraform workspace `aegis-auth0-dev` for remote state while execution remains local. Authenticate interactively in a normal VS Code terminal with `terraform login`; keep the token private. Run `node infra/terraform/auth0/hcp-preflight.mjs` for read-only verification of organization `aegis-ai-portfolio`, the Free plan, exact workspace, Local execution, auto-apply disabled, and state ownership. The first initialization is permitted only when HCP explicitly reports no current state. After successful initialization the wrapper stores a mode-0600 local ownership marker under ignored `.terraform/`; it contains identifiers and a resource inventory fingerprint, never state contents or credentials. Future `init` and `plan` require secure local backend metadata plus an unchanged HCP state-version ID, serial and exact five-resource inventory matching that marker. If a separately approved apply creates a new version, inspect the HCP version and then run `node infra/terraform/auth0/terraform-local.mjs bind-reviewed-state` interactively to rebind the local marker; this command verifies metadata, requires typing the workspace and version ID, and performs no Terraform or HCP write. Missing or changed metadata, state, marker, workspace or subscription stops for manual review. The wrapper sets `umask 077` and enforces mode `0600` on ignored backend metadata and the ownership marker. Backend metadata can contain authentication configuration, so keep it protected and local. Auth0 credentials remain in ignored `.env.auth0` on the local Mac; do not paste HCP tokens or Auth0 credentials into chat or CI. Remote state must not be downloaded, committed, or copied to an unencrypted backup.

After the SPA and API are provisioned and API configuration is set locally, run `node apps/api/scripts/auth0-pkce-smoke.mjs` in a normal terminal. It performs a loopback Authorization Code + PKCE login and makes one protected case-list request. The bearer token exists only in process memory and is never printed or persisted. A test user must first have a database membership for the exact Auth0 subject; see the membership instructions above. This smoke test does not exercise writes, revocation, wrong issuer/audience, or all authorization cases; the existing integration tests use synthetic local signing keys. See [ADR 004](docs/adr/004-auth0-terraform-foundation.md) and the [security runbook](docs/SECURITY-RUNBOOK.md).

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

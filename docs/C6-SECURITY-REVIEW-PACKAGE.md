# C6 security-review package (for an independent reviewer)

Status: **C6 PARTIAL**. This package asks for an independent external security assessment. It is not one.

**Important:** the reviews performed during development were carried out by Claude (an AI agent) in the same working session as the implementation. They informed development and found real issues, which are fixed here. They do not count as independent assessment, and nothing in this repository should describe them as such. Only a review by a party with no part in building the code can close C6's review requirement.

## 1. Scope

In scope: the local MCP server in `apps/api/src/mcp/` (stdio transport, read-only tools), its use of the policy gateway, identity verification, tenant membership, rate limiting, approvals and audit, and the adjacent changes in `apps/api/src/agents/tool-dispatcher.ts` and `apps/api/src/security/`.

Out of scope: any HTTP or remote transport (not implemented), OAuth or external identity-provider configuration (not changed), production databases (none used), the web application, and the retrieval and evaluation work.

Branch and pull request: `c6-mcp-server`, [PR #76](https://github.com/AnkurSingh16/aegis-ai-architect-portfolio/pull/76), stacked on `c10-security-hardening` (PR #72). Review the commit of PR #76 at the time of review; pin the commit SHA in the review record.

## 2. Architecture in one paragraph

An MCP client starts the server as a local process (stdio). The server is disabled unless `AEGIS_MCP_ENABLED=1`. It serves one tenant from `AEGIS_MCP_TENANT_ID` and holds one bearer token from `AEGIS_MCP_BEARER_TOKEN`. Each incoming `tools/call` passes through a pre-dispatch gate, then admission control, then strict argument validation, then the SDK, then a fresh credential check, a database membership check for the configured tenant, and the existing `ToolGateway` (scopes, tenant binding, argument screening, PostgreSQL rate limit, approvals, single-use runs). Every admitted call and every refused call writes one structured audit line to stderr.

## 3. Authentication boundary

| Control | Where | Notes |
| --- | --- | --- |
| Startup credential check | `mcp/stdio.ts` | The configured token must verify through the production verifier before the server connects. Failure exits with code 5. |
| Per-call credential check | `mcp/server.ts` step 1 | Re-verified on every admitted call. Failure returns `Authentication required.` and audits `unauthenticated`. |
| Token verification | `auth/token.ts` | jose RS256, issuer, audience, expiry, scope claim. The test-key resolver is refused outside `NODE_ENV=test`. |
| Verified principal | `auth/token.ts` | Principals are frozen and marked in a module-private set, so a hand-built principal cannot pass as verified. |
| Gateway context | `security/tool-policy-gateway.ts` `verifiedRequestContext` | Accepts only verified principals; hand-built contexts are denied with `unverified_context`. |

Trust assumption: the bearer token is the only credential, and whoever can read the process environment can use it (see section 9).

## 4. Tool registration controls

- Production registry is fixed in code: `PRODUCTION_REGISTRY` in `mcp/server.ts`, two read-only tools from `mcp/tools.ts`. `createAegisMcpServer` accepts no tool, registry or extension argument.
- `createRegisteredServer` refuses any definition that is not read-only with no approval requirement unless `allowSideEffects` is passed, and refuses `allowSideEffects` outside `NODE_ENV=test`.
- `createTestAegisMcpServer` (`mcp/test-support.ts`) is the only way to add tools, and it is test-only by the guard above.
- Tool schemas are strict (`z.object(...).strict()`); the gate validates with the same schema the tool advertises.
- The gate refuses a `tools/call` for an unregistered name before any other work.

Questions for the reviewer: is the test-only guard sufficient, or should the synthetic tool live outside `src/` entirely? Is the post-connect transport wrapping acceptable given the SDK's ordering (section 5)?

## 5. Pre-dispatch gate and admission control

- The SDK validates tool arguments before the application callback runs, so a call it rejects was never audited. The gate in `mcp/gate.ts` closes that gap for `tools/call` messages.
- The gate is installed after `server.connect()` returns, by replacing the transport's message handler. The SDK wrapper calls any earlier handler and then processes the message regardless, so an earlier handler cannot veto. Messages are only delivered after the transport starts, so for stdio no message can arrive between connect and the wrapper. The in-memory test transport has the same ordering in practice; the reviewer should confirm this.
- `GuardedMcpServer.connect` is the only connect path; the raw SDK server is not returned.
- Admission (`mcp/admission.ts`) runs before parsing: a token bucket (default burst 30, 5 per second) and an in-flight cap (default 2, below the pool size of 4). It refuses with `admission_throttled` or `admission_saturated` and consumes no database connection.
- In-flight slots are released when the SDK answers the request id, or after 60 seconds if it never does. A reused in-flight id is refused.

Trust assumption: admission is per process and in memory. Two processes do not share it. The PostgreSQL gateway limiter is shared per tenant and agent.

## 6. Tenant isolation

- The tenant comes only from configuration. Arguments that name a tenant are refused by the strict schema (and audited).
- Membership and scope are checked in PostgreSQL (`withAuthenticatedTransaction` against `aegis.memberships`, which has row-level security with forced RLS per migration 002). The reviewer should confirm RLS coverage of every table the MCP tools read (`documents`, `document_chunks`, `tool_approvals`, `rate_limit_buckets`).
- The gateway context's tenant is the configured tenant. The `documents.search` handler scopes its query to `context.tenantId` through the authenticated transaction.
- Tests: a member of tenant B cannot use a server configured for tenant A; a non-member is refused; approvals from another tenant are not found.

Not tested: a tenant-B member reading tenant-A rows through a path other than the membership check. The reviewer should confirm RLS is the only data path.

## 7. Approval flows

- Built-in tools need no approval. The approval reference is accepted only by tools that declare `approvalId`, and the read-only schemas refuse it.
- The approval reference is a model-supplied pointer. The gateway validates it against the trusted store: tenant-scoped lookup, action digest over the action arguments only (the reference is split out before digesting), requester and approver differ, not expired, single use under concurrency.
- The synthetic side-effecting tool exists only in tests and is refused outside them. It performs no external effect.

Questions for the reviewer: is splitting `approvalId` from the arguments before digesting the only place where the digest could diverge? Is a model-supplied approval reference acceptable at all, or should approvals bind to the human session?

## 8. Rate limiting

- Admission (section 5) runs first, per process.
- The gateway's PostgreSQL bucket runs for every admitted call (60 burst, 20 per second, keyed by tenant and agent; forced RLS; DB clock). A limiter failure fails closed (`rate_limit_unavailable`).
- Both values are provisional and not calibrated.

## 9. Credential exposure, expiry and rotation

See `docs/C6-MCP-SERVER.md`, "Credential handling". Summary: the bearer token is an environment variable, visible to other processes running as the same user; it is never logged or audited; it is verified on every admitted call; expiry fails closed; rotation requires a restart; no revocation before expiry.

## 10. Audit behaviour

- One `mcp.tool_call` line per admitted or refused call, to stderr.
- Fields: time, random request reference, tool name (or `unregistered`), configured tenant, subject digest (null when refused before verification), outcome, reasons, duration, and allowlisted numeric detail (`queryLength`, `resultCount`, `issueCount`).
- Never recorded: arguments, query text, tool output, validator messages, the token, the raw subject.
- Tests check one event per call across admitted and refused calls, and that submitted values and the token do not appear in audit or responses.

Known gap: audit lines go to stderr and nothing ships or retains them. Retention and tamper evidence are not implemented.

## 11. Known limitations (summary)

1. No independent external security assessment yet.
2. Stdio success path not automated (needs a real https JWKS and a real identity-provider token); only refusal paths are tested in CI.
3. Bearer token in environment; no revocation; restart to rotate.
4. Admission and in-process bounds are per process.
5. Rate-limit values are provisional.
6. No production side-effecting tool; approval path proven only with a synthetic test tool.
7. Replay of a valid bearer token is accepted until expiry.
8. Not tested: credential expiry mid-session (no clock control), two processes sharing the PostgreSQL bucket, database failure after membership succeeds.
9. `tools/list` is not audited.
10. Audit is stderr only; no retention, shipping or tamper evidence.

## 12. Evidence

Reproduce on a disposable PostgreSQL 17 database only (never production). Use the CI-style isolated roles and passwords from `.github/workflows/ci.yml`, on a loopback port you control.

```bash
cd apps/api
export TEST_DATABASE_ADMIN_URL=postgres://aegis_ci_admin:<admin-password>@127.0.0.1:<port>/aegis_test
export TEST_DATABASE_URL=postgres://aegis_app:<app-password>@127.0.0.1:<port>/aegis_test
export TEST_DOCUMENT_INGEST_URL=postgres://aegis_ingest:<ingest-password>@127.0.0.1:<port>/aegis_test
export DATABASE_APP_PASSWORD=<app-password> DATABASE_INGEST_PASSWORD=<ingest-password>
npx vitest run -c vitest.integration.config.ts src/mcp
npx vitest run src/mcp
cd ../.. && npm run lint && npm run typecheck && npm run test:coverage
```

Results at the commit that adds this package (run on a fresh disposable PostgreSQL 17 container): lint and typecheck clean; API unit suite 107 files and 1022 tests passing; web 47 tests passing; integration suite 16 files and 189 tests passing, 10 live-model tests skipped; MCP integration 33 tests across two files (20 baseline, 13 adversarial); MCP unit and stdio refusal tests passing; `git diff --check` clean. The reviewer should re-run these and record the commit SHA.

## 13. What the reviewer should try to break

1. Obtain a tool call that reaches the SDK without passing the gate (for example by writing to the transport directly, or by a path that connects without `GuardedMcpServer`).
2. Get a read-only tool to accept an `approvalId`, or get an approval reference to authorise a different action digest.
3. Make a tenant-B member read tenant-A documents through any path.
4. Exhaust the database pool or the admission bounds from one client; check the bounded behaviour under concurrency.
5. Cause a secret or a submitted value to appear in a model-visible response, an audit line or a diagnostic.
6. Register a side-effecting tool in a production build.
7. Reuse an approval, a request id, or an expired token.

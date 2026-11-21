# C6 security-review package (for an independent reviewer)

## Status

- **C6: PARTIAL.**
- **Independent external review: PENDING.** No reviewer has been engaged. This package is ready for one.
- **Development reviews are not independent.** The reviews run during development were performed by Claude, an AI agent, in the same working session that built the controls. They found issues that were fixed, but they do not count as an independent assessment, and nothing in this repository may describe them as one. Only a reviewer with no part in building these controls can close the review requirement.

## 1. Exact commits under review

| Item | Reference |
| --- | --- |
| Code under review (CI passing on PR #76) | commit `db3e6d6` on branch `c6-mcp-server` (`fix(mcp): pre-dispatch gate, admission control, read-only production registry (C6 round 2)`) |
| Earlier implementation | commit `9d46174` (`feat(mcp): local MCP server over the existing policy gateway (C6, PARTIAL)`) |
| Documentation and this package | the commit that contains this file. Record its SHA when the reviewer is engaged; it is not part of the code under review |
| Pull request | [PR #76](https://github.com/AnkurSingh16/aegis-ai-architect-portfolio/pull/76), head `c6-mcp-server`, base `c10-security-hardening` (PR #72) |
| Base lines | C6 depends on C10. C9, C1 and C2 are on a separate continuation of that stack and are not included here |

The reviewer should record the exact SHA they review and confirm it matches the above.

## 2. Architecture

An MCP client starts the server as a local process over stdio. The server is disabled unless `AEGIS_MCP_ENABLED=1`. It serves one tenant from `AEGIS_MCP_TENANT_ID` and holds one bearer token from `AEGIS_MCP_BEARER_TOKEN`.

Each incoming `tools/call` passes through these stages, in order:

1. **Transport gate** (`apps/api/src/mcp/gate.ts`), installed after `server.connect()` returns.
2. **Admission control** (`mcp/admission.ts`): a token bucket and an in-flight cap, per process, before any parsing, verification or database work.
3. **Shape and strict-argument validation** in the gate, using the same strict schema the tool advertises. A refusal is audited and returns a generic message.
4. **SDK dispatch** (`@modelcontextprotocol/sdk` 1.32.2), which validates again and calls the registered callback.
5. **Credential re-verification** through the production verifier (`auth/token.ts`).
6. **Membership and scope** in PostgreSQL for the configured tenant (`withAuthenticatedTransaction`, `aegis.memberships`).
7. **Verified gateway context** built from the principal and the configured tenant (`verifiedRequestContext`).
8. **Gateway authorisation** (`security/tool-policy-gateway.ts`): scopes, tenant binding, argument screening, the PostgreSQL rate limit, approvals (digest-bound, single use), and single-use run identifiers.
9. **Structured audit** (`mcp/audit.ts`): one line to stderr per admitted or refused call.

Tools: `case.triage` (synthetic triage) and `documents.search` (tenant-scoped lexical retrieval). Both are read-only, with the `read:cases` scope.

## 3. Trust boundaries

| Boundary | Trusted side | Untrusted side | Control |
| --- | --- | --- | --- |
| Client to server | Server process configuration | MCP client and any model driving it | Gate, strict schemas, no identity or tenant in arguments |
| Process environment | Server process | Other processes of the same user | None beyond local-only operation; see section 5 |
| Identity provider to server | Production verifier (issuer, audience, signature, expiry) | Token bearer | Re-verified on every admitted call |
| Server to database | Membership and RLS | Any caller that reaches the pool | Membership check per call; tenant context set per transaction |
| Server to gateway | `verifiedRequestContext` from a verified principal | Hand-built contexts | Denied with `unverified_context` |
| Test code to production | Test-only tool registration | Production factory | Guard on `NODE_ENV=test` and registry identity (section 4) |

## 4. Review areas and where to look

### 4.1 Transport gate installed after SDK connect

- Implementation: `guardTransport` in `mcp/gate.ts`, called from `createRegisteredServer` (`mcp/server.ts`) after `await server.connect(transport)`.
- Mechanism: the gate saves the SDK's `onmessage` handler and replaces it. It also wraps `transport.send` so that a response releases its admission slot.
- Ordering assumption: the SDK wrapper calls any handler present before `connect` and then processes the message regardless, so the gate cannot be installed before connect. The gate relies on no message reaching the transport between `connect` resolving and the gate being installed. For stdio, data events are delivered on later event-loop turns. For the in-memory test transport the gate was installed before the client sent any request in the tests. Both are assumptions; the reviewer should confirm them.
- Bypass paths to check: calling the SDK server directly (not exposed; `createRegisteredServer` returns only `connect` and `close`); a transport whose `onmessage` is set by something else after the gate; batched messages (the 2025-11-25 protocol does not use batches, and the gate handles one message at a time); a `tools/call` whose id is reused after release; a response that never arrives (released after 60 seconds).
- SDK compatibility: the gate depends on the SDK's `Protocol.connect` wrapping and on the `onmessage`/`send` shape of `Transport`. A minor SDK upgrade that changes either would fail tests in `gate` integration coverage. The reviewer should check whether a future SDK could add an earlier interception point that makes the gate redundant or inconsistent.

### 4.2 `createRegisteredServer` and alternative production call paths

- `createAegisMcpServer(options)` is the production entry point. It passes `PRODUCTION_REGISTRY` and `allowSideEffects: false`. It accepts no tool, registry or extension argument.
- `createRegisteredServer(options, registry, policy)` is exported because the test-support module needs it. Two checks apply:
  1. If `allowSideEffects` is true, it throws unless `NODE_ENV === 'test'`.
  2. If `allowSideEffects` is false, it throws unless `registry` is the `PRODUCTION_REGISTRY` object by identity, and it refuses any definition that is not read-only with no approval requirement.
- Residual risks for the reviewer: (a) the `NODE_ENV` guard is an environment check, so a process started with `NODE_ENV=test` in production would pass it; (b) any code that imports `createRegisteredServer` and `PRODUCTION_REGISTRY` could still call the factory with the production registry, which is the intended behaviour; (c) `createTestAegisMcpServer` is in `src/`, so it ships in the build unless excluded. The reviewer should decide whether the test module should be excluded from the production build, or moved out of `src/`.

### 4.3 Credential handling

- Token source: `AEGIS_MCP_BEARER_TOKEN`, an environment variable. See `docs/C6-MCP-SERVER.md`, "Credential handling".
- Verified at startup (exit code 5 on rejection) and on every admitted call.
- Not logged, not audited, not echoed. Tests check that the token does not appear in responses or audit events.
- Expiry: fails closed with `Authentication required.` for every call. No refresh.
- Rotation: restart with a new token. No revocation before expiry.
- Exposure: other processes of the same user may read the environment. There is no secret store.

### 4.4 Authentication and tenant isolation

- The configured tenant is the only tenant. Arguments naming a tenant are refused by the strict schema.
- Membership is checked per call with `withAuthenticatedTransaction` on `aegis.memberships`, which has row-level security with forced RLS (migration 002).
- Tests: a member of tenant B cannot use a tenant-A server; a non-member is refused; approvals from another tenant are not found; a tenant named in arguments is refused.
- Not tested: whether row-level security covers every table the tools read. The reviewer should confirm RLS for `documents`, `document_chunks`, `tool_approvals` and `rate_limit_buckets`, and that no other data path exists.

### 4.5 Admission control and database exhaustion

- Admission (`mcp/admission.ts`) runs before verification or database work. Defaults: burst 30, 5 per second, at most 2 calls in flight. The stdio pool holds 4 connections.
- A refused call does not touch the pool. Tests count database connection requests and check that throttled calls do not reach it.
- Slots are released when the SDK responds, or after 60 seconds if it does not.
- The gateway's PostgreSQL bucket (60 burst, 20 per second, keyed by tenant and agent) still runs for admitted calls. If it cannot decide, the gateway fails closed.
- Limits: per process only; values are provisional and not calibrated; a slow database can still hold admitted calls for their duration.

### 4.6 Approval enforcement

- Read-only tools declare no `approvalId`, and their strict schemas refuse one.
- For a side-effecting tool, `approvalId` is split out of the arguments before the gateway digests them. The digest covers only the action arguments.
- The gateway checks tenant, digest, approver not the requester or agent, not expired, and single use under concurrency. Tests cover missing, replayed, digest-mismatched, cross-tenant and pending approvals.
- The only side-effecting tool is synthetic and exists in test code. No production tool has an approval path.

### 4.7 Audit completeness

- One `mcp.tool_call` line per admitted or refused call, to stderr.
- Refused calls before verification have a null subject reference. The tool field is `unregistered` when the name is not registered.
- Recorded: request reference, tool, tenant, subject digest, outcome, reasons, duration, and allowlisted numbers (`queryLength`, `resultCount`, `issueCount`).
- Not recorded: arguments, values, query text, tool output, validator messages, the token, the raw subject.
- Test: one event per call across admitted and refused calls. Gaps: audit goes to stderr only, with no retention, shipping or tamper evidence.

### 4.8 The test-only tool boundary

- `createTestAegisMcpServer` (`mcp/test-support.ts`) adds the synthetic tool. It refuses to run outside `NODE_ENV=test`.
- The synthetic tool performs no external effect. Its handler increments a counter.
- The reviewer should decide whether this module must be excluded from production builds (see 4.2).

## 5. Known limitations

1. No independent external review has been performed. The review is PENDING.
2. The stdio success path is not automated. It needs an https JWKS and a real identity-provider token for a non-production tenant. CI runs only the refusal paths.
3. The bearer token is an environment variable, with no revocation and rotation by restart.
4. Admission and its in-flight cap are per process and in memory.
5. The gateway rate-limit and admission values are provisional.
6. No production side-effecting tool exists. The approval path is proven only with the test-only synthetic tool.
7. A valid bearer token is replayable until it expires.
8. Not tested: credential expiry mid-session (no clock control), two processes sharing the PostgreSQL bucket, and a database failure after membership succeeds.
9. `tools/list` is not audited. It returns the fixed registry and touches no tenant data.
10. The `NODE_ENV` guard depends on the environment; registry identity is the stronger control.
11. The gate depends on SDK internals (section 4.1) and must be re-tested on every SDK upgrade.
12. Audit is stderr only, with no retention or tamper evidence.

## 6. Test evidence

Reproduce on a disposable PostgreSQL 17 database only. Never use a production database. Use the CI-style isolated roles and passwords from `.github/workflows/ci.yml`, on a loopback port you control.

```bash
git checkout c6-mcp-server        # or the commit recorded in section 1
cd apps/api
export TEST_DATABASE_ADMIN_URL=postgres://aegis_ci_admin:<admin-password>@127.0.0.1:<port>/aegis_test
export TEST_DATABASE_URL=postgres://aegis_app:<app-password>@127.0.0.1:<port>/aegis_test
export TEST_DOCUMENT_INGEST_URL=postgres://aegis_ingest:<ingest-password>@127.0.0.1:<port>/aegis_test
export DATABASE_APP_PASSWORD=<app-password> DATABASE_INGEST_PASSWORD=<ingest-password>
npx vitest run src/mcp                                   # unit and stdio refusal tests
npx vitest run -c vitest.integration.config.ts src/mcp   # MCP integration and adversarial tests
cd ../.. && npm run lint && npm run typecheck && npm run test:coverage
```

Recorded results:

- CI on PR #76 at `db3e6d6`: passing (confirmed by the project owner).
- Local, at `db3e6d6`, fresh disposable PostgreSQL 17: lint and typecheck clean; API unit suite passing; full integration suite passing with 10 live-model tests skipped; MCP integration 34 tests across two files (20 baseline, 14 adversarial, including one added for the registry-identity check).
- The reviewer should re-run these on their own environment and record the outputs.

## 7. What the reviewer should try to break

1. Obtain a tool call that reaches the SDK without passing the gate.
2. Get a read-only tool to accept an `approvalId`, or make an approval authorise a different action digest.
3. Make a tenant-B member read tenant-A documents through any path.
4. Exhaust the database pool or the admission bounds from one client.
5. Cause a secret or a submitted value to appear in a response, audit line or diagnostic.
6. Register a side-effecting tool through any production path, including `createRegisteredServer` with a crafted registry.
7. Reuse an approval, a request id or an expired token.
8. Check the gate against the SDK version pinned in `apps/api/package.json` (1.32.2) and against the next minor version.

## 8. Engagement record (to complete)

| Field | Value |
| --- | --- |
| Reviewer organisation | PENDING |
| Reviewer independence statement | PENDING |
| Commit reviewed | PENDING |
| Date of engagement | PENDING |
| Report reference | PENDING |
| Outcome | PENDING |

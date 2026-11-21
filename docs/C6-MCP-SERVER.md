# C6: Model Context Protocol server (PARTIAL)

Status: **PARTIAL**. Not production-ready. An independent external security review is required before any claim beyond local, synthetic use. The review package is in [C6-SECURITY-REVIEW-PACKAGE.md](C6-SECURITY-REVIEW-PACKAGE.md).

## Purpose

Expose a small set of verified, read-only AEGIS capabilities to an MCP client, without creating a second security system. The MCP layer adds no permission of its own. It admits or refuses the call, authenticates, checks tenant membership, and then asks the existing `ToolGateway`, the same gateway the direct tool route uses.

## Architecture

```
MCP client (stdio, local process)
   │  JSON-RPC over stdin/stdout (protocol 2025-11-25 via SDK 1.32.2)
   ▼
apps/api/src/mcp/gate.ts           pre-dispatch gate, installed by GuardedMcpServer.connect (tools/call only)
   0a. admission                   token bucket and in-flight cap, BEFORE any parsing, verification or database work (admission.ts)
   0b. shape and strict arguments  same strict schema the tool advertises; a refusal gets a generic message and one audit event
   ▼  (admitted calls only; the response releases the in-flight slot)
apps/api/src/mcp/server.ts         createAegisMcpServer (production) / createRegisteredServer (shared core)
   1. verify credential again       production verifier (auth/token.ts, jose RS256, issuer, audience, expiry)
   2. membership and scope          withAuthenticatedTransaction on the CONFIGURED tenant (PostgreSQL, RLS)
   3. verified context              verifiedRequestContext(principal, { configured tenant, agent 'mcp-agent' })
   4. dispatch                      agents/tool-dispatcher.ts → security/tool-policy-gateway.ts
          scopes · tenant binding · argument screening · rate limit (PostgreSQL) · approval (digest, single use) · audit
   5. structured audit              one mcp.tool_call event per admitted call (audit.ts)
   ▼
tools: case.triage (synthetic triage), documents.search (tenant-scoped lexical retrieval)
```

Reused unchanged: `ToolGateway`, `verifiedRequestContext`, `AuthorizationError`/`requireScope`, the PostgreSQL rate limiter, the approval store, the in-process token bucket (`createTokenBucketLimiter`), `retrieveDocumentChunks`, `triageCase`. The one change to shared code is `ToolHandler.run`, which may be asynchronous and receives the authorised context. Its behaviour for synchronous handlers is unchanged.

### Why a gate, not a handler

The MCP SDK validates arguments before our callback runs, so a call rejected by the SDK never reached our audit code. The SDK also installs its `tools/call` handler during registration and refuses a second one. The gate therefore sits in front of the SDK for `tools/call` messages only. It is installed after `server.connect()` returns, because the SDK calls any earlier handler and then processes the message regardless, so it cannot veto from before connection. `GuardedMcpServer.connect` is the only way to connect; the raw SDK server is not exposed.

## Tool registry

- The production registry is fixed in code (`PRODUCTION_REGISTRY`): the two read-only tools, no extension point. `createAegisMcpServer` takes no tool or registry argument.
- `createRegisteredServer` is the shared core. It refuses any side-effecting definition unless the caller passes `allowSideEffects` **and** `NODE_ENV=test`. Without `allowSideEffects` it accepts only the `PRODUCTION_REGISTRY` object itself (checked by identity, so a look-alike read-only registry is refused) and refuses any definition that is not read-only with no approval requirement.
- `createTestAegisMcpServer` (`test-support.ts`) adds the synthetic side-effecting tool for the approval-boundary tests. Production code does not import it, and it is refused outside test runs.

## Tools

| Tool | Input | Output | Scope | Side effect |
| --- | --- | --- | --- | --- |
| `case.triage` | `{ caseId }` enum of the three synthetic case ids | `mode`, `caseId`, `category`, `priority`, `suggestedTeam`, `rationale`, `nextStep`, fixed `warning` | `read:cases` | none |
| `documents.search` | `{ query }`, 1 to the retrieval query limit | up to 5 `{ sourceIdentity, title, position, rank, content }` | `read:cases` | none |

Input schemas are strict. An unknown key (a tenant, a scope, a principal) is refused before any handler runs. Tool annotations: `readOnlyHint: true`, `destructiveHint: false`.

## Validation and refusals

- A refused call returns a tool result with `isError: true` and the generic text `Invalid request.`, `Too many requests. Please retry later.`, `Authentication required.`, `Access denied.` or `The request could not be completed. Please retry.`. None of these repeats a submitted value or a validator message.
- Each refusal writes exactly one audit event. Outcomes: `invalid_input` (reasons `malformed_request`, `unknown_tool`, `schema_validation`, `duplicate_request_id`; the `tool` field is `unregistered` when the name is not a registered tool), `throttled` (reasons `admission_throttled`, `admission_saturated`), `unauthenticated`, `not_a_member`, `denied` (gateway reasons), `error`, `allowed`.
- Validation diagnostics for development are off by default. With `AEGIS_MCP_DIAGNOSTICS=1` the process writes the tool name, field paths (sanitised to short plain tokens) and issue codes to stderr. Values are never written.

## Admission control

Admission runs first, before any parsing, verification, database or gateway work.

- Token bucket: `burst` (default 30) and `refillPerSecond` (default 5).
- In-flight cap: `maxConcurrent` (default 2), held until the SDK answers the request. The pool holds 4 connections in stdio, so the cap stays below it.
- A refusal does not consume a database connection and does not reach the membership query.
- A request id reused while still in flight is refused (`duplicate_request_id`), so one slot cannot be shared.
- A reserved slot is released after 60 seconds if the SDK never answers.
- Admission is per process. Several server processes each have their own bounds.

The gateway's PostgreSQL rate limiter (60 burst, 20 per second, shared per tenant and agent) still runs for every admitted call. Admission complements it and grants nothing: an admitted call still needs the full authentication, membership and gateway checks.

## Permission model

- **Identity** comes only from the credential the server process was started with, verified again on every admitted call. A model cannot supply, replace or influence it.
- **Tenant** is the one configured in `AEGIS_MCP_TENANT_ID`. Arguments that name a tenant are refused.
- **Membership** is checked in PostgreSQL for that tenant (`aegis.memberships`, role `reader` or `operator`).
- **Scope** `read:cases` is required on the token and by the tool; the agent registration grants only what the tool needs.
- **Approval**: built-in tools need none (read-only). For any side-effecting tool, the model may pass an `approvalId` that a person has approved. It is split out of the arguments so the digest covers only the action arguments. The gateway checks it against the trusted store: same tenant, same action digest, approved by someone other than the requester, not expired, not consumed. A model cannot approve its own action. Read-only schemas are strict, so they refuse an `approvalId` outright.

## Audit

One `mcp.tool_call` JSON line per call, written to standard error (standard output is the protocol). Fields: `at`, `requestRef` (random per call), `tool`, `tenantId`, `subjectRef` (first 12 hex of SHA-256 of the subject; null when the call is refused before verification), `outcome`, `reasons`, `durationMs`, and `detail` with only `queryLength`, `resultCount` and `issueCount`. Never recorded: arguments, query text, tool output, the bearer token, the raw subject, validator messages.

## Credential handling (environment bearer token)

The server reads `AEGIS_MCP_BEARER_TOKEN` from its environment. The risks, and the local-only decision on each:

| Risk | Effect | Current handling |
| --- | --- | --- |
| Exposure through the process environment | Other processes running as the same user may be able to read it (for example `/proc/<pid>/environ` on Linux, or process inspection tools). | Local only, single user. Not written to logs, audit events or error messages (tests check this). Rotate on any suspicion of exposure. |
| Shell history and shell exports | A token pasted on a command line can persist in history. | Run the command with the variable set in a launcher or secret store you control; do not commit it. |
| Expiry mid-session | The token is verified on every admitted call. After expiry every call is refused with `Authentication required.` and nothing is served. | Fail closed. Restart with a fresh token. No automatic refresh. |
| Rotation | Replacing the token requires a process restart, which drops in-flight calls. | Documented procedure: stop the process, set the new token, start again. No secret-manager integration. |
| Bearer semantics | Whoever holds a valid token holds its scope until it expires. | Short token lifetime at the identity provider, local transport, one tenant per process. Revocation before expiry is not implemented. |

No external identity-provider change, no OAuth client and no secret-management infrastructure is introduced. Any of those needs a separate decision.

## Protocol and transport

- Protocol: **2025-11-25** (the SDK's latest). The SDK negotiates the version with the client; this change did not enumerate the older versions the SDK also accepts.
- Transport: **stdio only**, local, and **disabled by default**. No HTTP listener, no public endpoint, no OAuth client, no remote network access. Those need separate approval.

## Configuration

| Variable | Meaning |
| --- | --- |
| `AEGIS_MCP_ENABLED` | Must be exactly `1`, or the process exits with code 2 and writes nothing to stdout |
| `AEGIS_MCP_TENANT_ID` | UUID of the one tenant this server serves |
| `AEGIS_MCP_BEARER_TOKEN` | Bearer token of a user who is a member of that tenant and holds `read:cases` (see Credential handling) |
| `AEGIS_MCP_DIAGNOSTICS` | Optional. `1` writes validation diagnostics (paths and codes, no values) to stderr |

Also required, as for the API: the authentication configuration (`resolveAuthConfig`) and the database URLs. Exit codes: `2` disabled; `3` invalid configuration; `4` database role check failed; `5` credential rejected at startup; `1` unexpected failure. Error messages name the setting and never its value.

## Local demonstration

Requires a real identity-provider token for a non-production tenant (the production verifier does not accept the test key).

```bash
cd apps/api
AEGIS_MCP_ENABLED=1 AEGIS_MCP_TENANT_ID=<tenant-uuid> AEGIS_MCP_BEARER_TOKEN=<token> npm run mcp:stdio
```

Point an MCP client that supports stdio at the command above. It should list two tools and call `case.triage` with `SYNTHETIC-LOGIN-001`.

## Tests

- Unit (`mcp.unit.test.ts`): configuration gating and redaction, audit detail allowlist, subject digest, strict schemas, read-only definitions, admission bounds, release-once semantics.
- Stdio refusals (`stdio.test.ts`): disabled exit code, invalid tenant and malformed credential exit codes, empty stdout, no secret in stderr.
- Integration (`mcp.integration.test.ts`, real PostgreSQL, real SDK client over `InMemoryTransport`, production verifier with test-signed RS256 tokens): discovery and annotations; `case.triage`; `documents.search` with tenant isolation; tenant, scope and unknown-field arguments refused; unknown case and oversized query; forged signature; token without `read:cases`; non-member; cross-tenant; rate limit; secrets and query text absent from errors and audit; one audit event per call; approval boundary with the test-only synthetic tool (no approval, replay, digest mismatch, cross-tenant approval, pending approval, read-only tool refusing an approval reference).
- Adversarial (`mcp.adversarial.integration.test.ts`, same environment): repeated unauthorised calls throttled before membership queries (three membership queries admitted, seven refused, audited); refusal distinct from denial in the audit; concurrency cap (four concurrent calls, one admitted, peak database requests 1); duplicate in-flight request id refused; extra fields refused without repeating the value; unknown, differently cased and path-like tool names refused; non-object arguments refused as malformed; diagnostics carry paths and codes but no values; the production factory ignores an injected extension, so no extra tool is listed or callable; side-effecting servers refused outside test runs; a read-only policy refuses a side-effecting definition; database outage returns a generic error without the underlying message; exactly one audit event per call across admitted and refused calls.

The synthetic side-effecting tool exists only inside test files. It is not registered in production and performs no external effect.

## Limitations

- Stdio success path is not automatically tested (needs an https JWKS). Only the refusal paths are automated.
- No HTTP or remote transport, and no OAuth. No remote network access.
- Rate-limit values (gateway and admission) are provisional and not calibrated. Admission is per process.
- Two read-only tools, synthetic data only. No production side-effecting tool.
- Replay of a still-valid bearer token is accepted by design (tokens are stateless JWTs with a short lifetime); the gateway's single-use protection applies to approvals, not to the credential.
- The bearer token is an environment variable with the risks in Credential handling. No revocation before expiry, no rotation without restart.
- `tools/list` is not audited. It returns the fixed read-only registry and touches no tenant data.
- The gateway's scope vocabulary and its assignment live in identity configuration, not in this change.
- Not independently reviewed for security.

## Adversarial test coverage

Covered: unauthorised call · repeated unauthorised calls · pre-membership throttling · cross-tenant access · invalid input · extra fields · malformed arguments · unknown and malformed tool names · forged identity · unscoped token · non-member · malicious arguments (tenant, scope, unknown key, oversized value, approval reference on a read-only tool) · rate limiting · concurrency cap · duplicate request id · approval replay · approval digest mismatch · cross-tenant approval · pending approval · sensitive-data exposure in errors, diagnostics and audit · database failure · unexpected tool registration · production registry boundary · credential rejected at startup · disabled startup.

Not yet covered: a rotated or expired credential mid-session (expiry is verified per call, but no test advances the clock), concurrent calls across two server processes sharing the PostgreSQL bucket, and a database outage mid-transaction after membership succeeds.

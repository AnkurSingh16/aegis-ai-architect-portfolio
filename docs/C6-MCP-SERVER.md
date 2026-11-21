# C6: Model Context Protocol server (PARTIAL)

Status: **PARTIAL**. Not production-ready. An independent security review is required before any claim beyond local, synthetic use.

## Purpose

Expose a small set of verified, read-only AEGIS capabilities to an MCP client, without creating a second security system. The MCP layer adds no permission of its own. It authenticates, checks tenant membership, and then asks the existing `ToolGateway`, the same gateway the direct tool route uses.

## Architecture

```
MCP client (stdio, local process)
   │  JSON-RPC over stdin/stdout (protocol 2025-11-25 via SDK 1.32.2)
   ▼
apps/api/src/mcp/server.ts         createAegisMcpServer
   1. verify credential again       production verifier (auth/token.ts, jose RS256, issuer, audience, expiry)
   2. membership and scope          withAuthenticatedTransaction on the CONFIGURED tenant (PostgreSQL, RLS)
   3. verified context              verifiedRequestContext(principal, { configured tenant, agent 'mcp-agent' })
   4. dispatch                      agents/tool-dispatcher.ts → security/tool-policy-gateway.ts
          scopes · tenant binding · argument screening · rate limit · approval (digest, single use) · audit
   5. structured audit              one mcp.tool_call event per call (mcp/audit.ts)
   ▼
tools: case.triage (synthetic triage), documents.search (tenant-scoped lexical retrieval)
```

Reused unchanged: `ToolGateway`, `verifiedRequestContext`, `AuthorizationError`/`requireScope`, the PostgreSQL rate limiter, the approval store, `retrieveDocumentChunks`, `triageCase`. The one change to shared code is `ToolHandler.run`, which now accepts an async handler and receives the authorised context. Its behaviour for synchronous handlers is unchanged.

## Tools

| Tool | Input | Output | Scope | Side effect |
| --- | --- | --- | --- | --- |
| `case.triage` | `{ caseId }` enum of the three synthetic case ids | `mode`, `caseId`, `category`, `priority`, `suggestedTeam`, `rationale`, `nextStep`, fixed `warning` | `read:cases` | none |
| `documents.search` | `{ query }`, 1 to the retrieval query limit | up to 5 `{ sourceIdentity, title, position, rank, content }` | `read:cases` | none |

Input schemas are strict. An unknown key (a tenant, a scope, a principal) is rejected by the SDK's validation before any handler runs. Tool annotations: `readOnlyHint: true`, `destructiveHint: false`.

## Permission model

- **Identity** comes only from the credential the server process was started with, verified again on every call. A model cannot supply, replace or influence it.
- **Tenant** is the one configured in `AEGIS_MCP_TENANT_ID`. Arguments that name a tenant are rejected.
- **Membership** is checked in PostgreSQL for that tenant (`aegis.memberships`, role `reader` or `operator`).
- **Scope** `read:cases` is required on the token and by the tool; the agent registration grants only what the tool needs.
- **Approval**: built-in tools need none (read-only). For any side-effecting tool, the model may pass an `approvalId` that a person has approved. The gateway checks it against the trusted store: same tenant, same action digest, approved by someone other than the requester, not expired, not consumed. A model cannot approve its own action.
- **Rate limit** is checked by the gateway before any other gateway check. The stdio entry point uses the shared PostgreSQL bucket (provisional values 60 burst, 20 per second).

## Audit

One `mcp.tool_call` JSON line per call, written to standard error (standard output is the protocol). Fields: `at`, `requestRef` (random per call), `tool`, `tenantId`, `subjectRef` (first 12 hex of SHA-256 of the subject), `outcome` (`allowed`, `denied`, `error`, `unauthenticated`, `not_a_member`), `reasons` (gateway deny reasons), `durationMs`, and `detail` with only `queryLength` and `resultCount`. Never recorded: arguments, query text, tool output, the bearer token, the raw subject.

## Protocol and transport

- Protocol: **2025-11-25** (the SDK's latest). The SDK negotiates the version with the client; this change did not enumerate the older versions the SDK also accepts.
- Transport: **stdio only**, local, and **disabled by default**. No HTTP listener, no public endpoint, no OAuth client, no remote network access. Those need separate approval.

## Configuration

| Variable | Meaning |
| --- | --- |
| `AEGIS_MCP_ENABLED` | Must be exactly `1`, or the process exits with code 2 and writes nothing to stdout |
| `AEGIS_MCP_TENANT_ID` | UUID of the one tenant this server serves |
| `AEGIS_MCP_BEARER_TOKEN` | Bearer token of a user who is a member of that tenant and holds `read:cases` |

Also required, as for the API: the authentication configuration (`resolveAuthConfig`) and the database URLs. Exit codes: `2` disabled; `3` invalid configuration; `4` database role check failed; `5` credential rejected at startup; `1` unexpected failure. Error messages name the setting and never its value.

## Local demonstration

Requires a real identity-provider token for a non-production tenant (the production verifier does not accept the test key).

```bash
cd apps/api
AEGIS_MCP_ENABLED=1 AEGIS_MCP_TENANT_ID=<tenant-uuid> AEGIS_MCP_BEARER_TOKEN=<token> npm run mcp:stdio
```

Point an MCP client that supports stdio at the command above. It should list two tools and call `case.triage` with `SYNTHETIC-LOGIN-001`.

## Tests

- Unit (`mcp.unit.test.ts`): configuration gating and redaction, audit detail allowlist, subject digest, strict schemas, read-only definitions.
- Stdio refusals (`stdio.test.ts`): disabled exit code, invalid tenant and malformed credential exit codes, empty stdout, no secret in stderr.
- Integration (`mcp.integration.test.ts`, real PostgreSQL, real SDK client over `InMemoryTransport`, production verifier with test-signed RS256 tokens): discovery and annotations; `case.triage`; `documents.search` with tenant isolation; tenant, scope and unknown-field arguments refused; unknown case and oversized query; forged signature; token without `read:cases`; non-member; cross-tenant; rate limit; secrets and query text absent from errors and audit; one audit event per call; approval boundary with a test-only synthetic side-effecting tool (no approval, replay, digest mismatch, cross-tenant approval, pending approval, read-only tool refusing an approval reference).

The synthetic side-effecting tool exists only inside the test file. It is not registered in production and performs no external effect.

## Limitations

- Stdio success path is not automatically tested (needs an https JWKS). Only the refusal paths are automated.
- No HTTP or remote transport, and no OAuth. No remote network access.
- Rate-limit values are provisional and not calibrated.
- Two read-only tools, synthetic data only. No production side-effecting tool.
- Replay of a still-valid bearer token is accepted by design (tokens are stateless JWTs with a short lifetime); the gateway's single-use protection applies to approvals, not to the credential.
- The gateway's scope vocabulary and its assignment live in identity configuration, not in this change.
- Not independently reviewed for security.

## Adversarial test list

Unauthorised call · cross-tenant access · invalid input · forged identity · malicious arguments (tenant, scope, unknown key, oversized value) · rate limiting · approval replay · approval digest mismatch · cross-tenant approval · pending approval · sensitive-data exposure in errors and audit · credential rejected at startup · disabled startup.

Not yet covered: a rotated or expired credential mid-session, concurrent calls exhausting a shared bucket across two server processes, and a database outage mid-call (the gateway fails closed; not exercised through MCP).

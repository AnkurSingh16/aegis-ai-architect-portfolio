# ADR 003: Auth0 identity and database-backed tenant authorization

## Status

Accepted for Milestone 2B local implementation.

## Context

Milestone 2A established forced PostgreSQL row-level security (RLS), but its local fixture selector is a trusted development boundary rather than end-user identity. Protected case APIs need to authenticate an external identity and authorize each tenant operation without trusting a tenant identifier supplied by a browser.

## Decision

- Accept Auth0 OAuth2/OIDC access-token JWTs only when verified with RS256 against JWKS derived from the configured HTTPS issuer. Validate exact issuer and API audience, require subject and expiry, and apply JWT not-before validation when present. Do not accept caller-selected key URLs, algorithms, token roles or permissions as authorization evidence.
- Read the signed `scope` claim for `read:cases` and `write:cases`. Require the requested scope and a server-managed PostgreSQL membership role for every operation.
- Store memberships as `(issuer, subject, tenant_id, role)`. Runtime `aegis_app` can select membership rows but cannot grant or revoke them; a local administrator CLI performs those operations.
- Resolve the verified principal and requested tenant membership, set transaction-local database context, and perform the case operation on one checked-out connection in a repeatable-read transaction. Forced RLS independently checks principal membership and tenant context. A URL tenant UUID selects the membership to check; it never proves access.
- Keep generated signing keys and injected JWKS resolvers inside code-driven tests. Do not add a runtime test-key environment switch.
- Preserve the synthetic demo; no browser login, production deployment, real customer records or LLM calls are part of this milestone.

## Consequences and limits

This keeps identity claims and data authorization separate: Auth0 proves the issuer and subject, while PostgreSQL membership is authoritative for tenant and role. Membership revocation or downgrade applies to transactions started after the administrative change commits; an in-flight repeatable-read request may finish using its established snapshot. Existing case-change audit rows do not contain an authenticated actor subject. Auth0 tenant configuration, rate limiting, production secrets and deployment remain operational work outside this local foundation. See [the security runbook](../SECURITY-RUNBOOK.md).

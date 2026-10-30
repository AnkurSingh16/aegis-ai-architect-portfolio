# Security runbook: local Auth0 case API

## Trust boundaries

- The browser's tenant path is only a requested resource selector. Authorization comes from a verified Auth0 `(iss, sub)` and a matching database membership.
- Auth0 issuer, API audience, and runtime database credentials are server configuration. Keep them in the ignored runtime-only `.env.api` locally and a secret manager for any later hosted environment. The broader `.env` is reserved for local Compose, migrations and administrator membership operations; never load it into the HTTP API process. Never print or paste bearer tokens or database URLs.
- The HTTP runtime uses `aegis_app`, a restricted non-owner role with forced RLS and SELECT-only membership access. The membership provisioning CLI requires separate administrator credentials and refuses the runtime role.
- The `north`/`south` fixture path remains for local synthetic CLI operations. Its server-controlled transaction mode is distinct from authenticated API mode. Fixture mode and its runtime credential are trusted local-server boundaries, not end-user authentication.

## Authentication and authorization

The verifier accepts Bearer JWTs signed with RS256 using JWKS at the fixed URL derived from the configured HTTPS issuer. It checks signature, issuer, exact API audience, expiry and not-before when present; subject and expiry are required. Runtime clients cannot set arbitrary JWKS URLs or test key resolvers. The protected API requires the signed `scope` claim. The database membership must also grant `reader` or `operator` as appropriate. Missing or invalid tokens return 401; missing scope or membership returns 403; an unavailable or foreign case is returned as not found.

Every protected operation uses one repeatable-read transaction. It sets transaction-local principal context, looks up membership, then sets tenant context and executes the operation on that same connection. RLS policies check the authenticated principal's membership and tenant context independently. Missing context defaults to deny. A request already in a repeatable-read transaction may complete using its snapshot after a concurrent membership revocation; new transactions observe the committed change.

## Local configuration and membership operations

1. Follow the Auth0 manual setup in the [README](../README.md#auth0-protected-case-api-milestone-2b). The API identifier is the JWT audience; the SPA client ID is not.
2. Copy `.env.api.example` to ignored `.env.api`. Set `AUTH0_ISSUER`, `AUTH0_AUDIENCE` and the restricted `DATABASE_URL` in that file. Keep administrator credentials in `.env`, which is used only by local Compose, migrations and membership administration. Start the server with `node --env-file=.env.api --import tsx apps/api/src/server.ts`. A partial Auth0 configuration fails startup; with both values absent, protected case routes are not registered.
3. Run the versioned database migration with the existing local migration command.
4. For a synthetic user, set `AEGIS_MEMBER_SUBJECT` to the exact verified Auth0 `sub`, `AEGIS_MEMBER_FIXTURE` to `north` or `south`, and `AEGIS_MEMBER_ROLE` to `reader` or `operator`. Grant using `node --env-file=.env --env-file=.env.api --import tsx apps/api/src/auth/membership-cli.ts grant`; revoke with the same issuer and subject and the `revoke` command. The CLI uses `DATABASE_ADMIN_URL`; never expose that credential to the API process.
5. Obtain a token with Authorization Code + PKCE from a local OAuth client, requesting the API audience and needed scopes. Send it in the Authorization header only. Do not put the token in query strings, logs or shell history.

## Verification and failure response

Run `npm run lint`, `npm run typecheck`, `npm run test:coverage`, `npm run build`, and `npm run test:integration -w apps/api` against the dedicated local `aegis_test` database. Tests use local generated RSA keys/JWKS and synthetic data; they do not contact Auth0. Runtime failures return stable messages and structured request identifiers without token contents, subjects, connection strings or raw SQL errors. If a test shows cross-tenant access, missing-context access, unexpected membership writes, or a leaked credential, stop the local API, preserve sanitized logs, and investigate the migration, runtime role and RLS before continuing.

## Known limits

- This is a local foundation, not production authentication operations. Auth0 tenant configuration and secret management are manual; there is no browser login, token refresh flow, rate limiting, cloud deployment or production monitoring.
- Database administrators can bypass RLS and remain trusted. Local fixture mode depends on trusted application code and runtime credentials.
- A case-change audit event records the case change but does not attribute it to the authenticated subject. Membership grant/revoke operations do not yet have a durable audit table.
- Repeatable-read transactions provide a consistent authorization snapshot. Revocation blocks new requests after commit but cannot cancel an already-running transaction.

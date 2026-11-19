# aegis/identity

- Optional Auth0 OIDC access-token verification: configured HTTPS issuer, issuer-derived JWKS, RS256 only, exact issuer and API audience, required subject and expiry (`apps/api/src/auth/`).
- Only signed `scope` values authorize API permissions. Role and permissions claims do not replace database authorization.
- Memberships bind verified issuer and subject to a tenant with `reader` or `operator` role. Both the scope and the membership role must permit the operation.
- Terraform for Auth0 (`infra/terraform/auth0`) manages only the API, scopes, the loopback SPA and one existing connection. Tenant-wide settings and cloud resources stay unmanaged.
- Decisions: `docs/adr/003-auth0-tenant-authorization.md`, `004-auth0-terraform-foundation.md`, `005-auth0-spa-signing-and-drift-reconciliation.md`.
- Known limit: membership revocation applies to new transactions only.

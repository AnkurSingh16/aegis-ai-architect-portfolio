# ADR 004: Narrow Auth0 Terraform ownership

## Status

Accepted for the local Milestone 2C foundation; no Auth0 resources have been applied by this repository change.

## Decision

Use an isolated Terraform root with the official `auth0/auth0` provider pinned to `1.59.0`. Manage only the Aegis Case API, the individual `read:cases` and `write:cases` permissions, one public SPA configured for Authorization Code + PKCE on a loopback callback, and that SPA's association with one explicitly supplied existing database connection.

Use the singular scope and connection-client resources so Terraform appends only the declared scope and client association instead of claiming ownership of whole existing sets. Do not manage the provisioner M2M app, tenant-wide settings, existing database connection configuration, Auth0 roles, PostgreSQL roles, or cloud resources. The API signs RS256 tokens. PostgreSQL reader/operator membership remains the authorization authority; the existing API JWT checks and RLS policies remain unchanged.

The provisioner secret is entered locally through a hidden-input helper into ignored `.env.auth0`, separate from PostgreSQL administrator `.env`. The local wrapper passes only the three Auth0 credential variables for plan, strips inherited database/Terraform override variables, uses no arbitrary arguments, and permits only format, init, validate, and unsaved plan. CI performs credential-free validation only with `init -backend=false`.

## Consequences

- The initial plan must be inspected for existing resources, conflicts, required imports, replacements and destructive actions before any apply. No apply is authorized by this ADR.
- HCP Terraform stores state remotely in the `aegis-auth0-dev` workspace, with local execution. Before initialization, an interactive Terraform CLI login and read-only preflight must confirm the exact organization/workspace, Free plan, Local execution, auto-apply disabled, and empty current state. The restricted wrapper repeats these checks at the `init` boundary, applies `umask 077` to Terraform processes, and enforces mode `0600` on ignored local backend metadata. The preflight never creates resources or prints the CLI token.
- The workspace is dedicated to this configuration. Do not initialize if it is not empty or its settings differ from the expected values. The local wrapper still denies apply, destroy, import, and state commands; resource creation requires separately approved changes to that boundary.
- GitHub CI remains credential-free and uses backend-disabled initialization; it does not access HCP state or live Auth0 resources.
- Management API permissions may be insufficient for a requested plan. Report missing permissions precisely; expand the provisioner grants only after separate approval.
- Auth0 Free-plan capabilities vary. This configuration does not create Auth0 roles or require Role Management; tenant membership and reader/operator privileges stay in PostgreSQL.
- A local PKCE smoke harness sends one access token directly to the local protected API, keeping the token in memory and out of files and logs.

## Alternatives considered

- Managing complete connection-client or resource-server scope collections was rejected because it could replace unrelated existing associations/scopes.
- Adding Auth0 roles or tenant-wide settings was rejected as unnecessary for the local Free-plan boundary and could introduce plan incompatibility or unrelated global changes.
- Putting the provisioner secret in shell arguments, Terraform variables, source files, or PostgreSQL `.env` was rejected because those paths increase exposure and mix independent trust domains.

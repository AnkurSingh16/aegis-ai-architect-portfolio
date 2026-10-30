# ADR 004: Narrow Auth0 Terraform ownership

## Status

Accepted for the local Milestone 2C foundation; no Auth0 resources have been applied by this repository change.

## Decision

Use an isolated Terraform root with the official `auth0/auth0` provider pinned to `1.59.0`. Manage only the Aegis Case API, the individual `read:cases` and `write:cases` permissions, one public SPA configured for Authorization Code + PKCE on a loopback callback, and that SPA's association with one explicitly supplied existing database connection.

Use the singular scope and connection-client resources so Terraform appends only the declared scope and client association instead of claiming ownership of whole existing sets. Do not manage the provisioner M2M app, tenant-wide settings, existing database connection configuration, Auth0 roles, PostgreSQL roles, or cloud resources. The API signs RS256 tokens. PostgreSQL reader/operator membership remains the authorization authority; the existing API JWT checks and RLS policies remain unchanged.

The provisioner secret is entered locally through a hidden-input helper into ignored `.env.auth0`, separate from PostgreSQL administrator `.env`. The local wrapper passes only the three Auth0 credential variables for plan, strips inherited database/Terraform override variables, uses no arbitrary arguments, and permits only format, init, validate, and unsaved plan. CI performs credential-free validation only with `init -backend=false`.

## Consequences

- The initial plan must be inspected for existing resources, conflicts, required imports, replacements and destructive actions before any apply. No apply is authorized by this ADR.
- HCP Terraform stores state remotely in the `aegis-auth0-dev` workspace, with local execution. Initial initialization requires a read-only preflight to confirm the exact organization/workspace, verified Free plan, Local execution, auto-apply disabled, and an explicitly empty current-state relationship. After a successful bootstrap, the wrapper records a mode-0600 local ownership marker in ignored `.terraform/`. Reinitialization and planning require the exact protected cloud-backend metadata and a current state version whose ID, serial, and exact five-resource Auth0 inventory fingerprint match that marker. Unknown state shapes, missing/replaced versions, mismatched workspace/backend metadata, changed inventory, or unsafe file permissions stop for manual review. The wrapper never migrates, overwrites, downloads, or imports state.
- After a separately approved apply changes the HCP state version, the operator must inspect that version and use `node infra/terraform/auth0/terraform-local.mjs bind-reviewed-state` interactively. This local-only operation verifies the exact workspace and resource inventory, requires typing the workspace and state-version ID, then atomically updates the protected marker; it does not invoke Terraform or write to HCP. The wrapper applies `umask 077`, keeps the local backend metadata and marker at mode `0600`, and never prints the CLI token. Backend metadata can contain authentication configuration and must remain protected and local.
- The local wrapper denies apply, destroy, import, and state commands; resource creation requires separately approved changes to that boundary.
- GitHub CI remains credential-free and uses backend-disabled initialization; it does not access HCP state or live Auth0 resources.
- Management API permissions may be insufficient for a requested plan. Report missing permissions precisely; expand the provisioner grants only after separate approval.
- Auth0 Free-plan capabilities vary. This configuration does not create Auth0 roles or require Role Management; tenant membership and reader/operator privileges stay in PostgreSQL.
- A local PKCE smoke harness sends one access token directly to the local protected API, keeping the token in memory and out of files and logs.

## Alternatives considered

- Managing complete connection-client or resource-server scope collections was rejected because it could replace unrelated existing associations/scopes.
- Adding Auth0 roles or tenant-wide settings was rejected as unnecessary for the local Free-plan boundary and could introduce plan incompatibility or unrelated global changes.
- Putting the provisioner secret in shell arguments, Terraform variables, source files, or PostgreSQL `.env` was rejected because those paths increase exposure and mix independent trust domains.

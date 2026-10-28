# ADR 002: local PostgreSQL multi-tenant case storage

Status: accepted for Milestone 2A local demonstration.

## Context

The existing synthetic triage UI is deterministic and stateless. The portfolio needs evidence of persistent, isolated case storage without implying production identity or exposing unauthenticated writes. The existing Compose service provides PostgreSQL 17 with a persistent local volume.

## Decision

Use explicit SQL migrations and the Node `pg` driver. Separate administrator migration credentials from a nonowner `aegis_app` login role with no superuser, RLS bypass, role creation, database creation, replication or inherited membership privileges. Runtime verifies role attributes, absence of memberships, denied schema/database creation, and forced RLS on the three protected tables before use.

Model synthetic tenants, support cases and append-only case-change audit events. Allow only supplied synthetic case IDs and bounded statuses; accept no customer text. Composite tenant/case foreign keys prevent cross-tenant audit associations. All tenant-bearing tables enable and force RLS with both `USING` and `WITH CHECK`; missing context denies rows. Runtime has only SELECT, limited-column case INSERT and status UPDATE privileges. It cannot delete/truncate tables or write audit records directly.

Each operation checks out one pooled connection, begins a transaction, sets `aegis.tenant_id` with parameterized transaction-local `set_config`, performs its queries and commits. Errors roll back; rollback connection failures destroy the connection. Context expires at transaction end. Never use session-wide tenant settings or separate pool queries inside a transaction callback.

Keep storage in a development CLI. Select `north` or `south` through server-owned environment configuration, which maps to fixed synthetic tenant UUIDs. No HTTP storage routes or arbitrary tenant arguments exist. Browser tenant IDs cannot authorize database access. Existing browser triage remains unchanged; stored-case triage uses the same explicitly labeled mock lookup.

Database triggers append create/update audit events atomically with each mutation. The narrowly scoped trigger function uses a fixed `pg_catalog` search path and schema-qualified tables, checks tenant context and has no direct runtime/PUBLIC execution grant. It runs with migration-administrator privileges to append audit data without granting audit writes to runtime. The administrator and migration source are trusted. Audit stores IDs, actions and status transitions, not request bodies or credentials.

Versioned migrations run in one transaction under an advisory lock and record SHA-256 checksums. Replays reject changed or missing applied files and out-of-order additions. Bootstrap creates the runtime role only if absent; it refuses unsafe existing attributes/memberships and does not silently rotate passwords. Use a new migration for schema evolution; no automatic destructive down-migration is provided.

## Consequences and limits

- Database policies catch application queries that omit tenant filters. Direct SQL using the runtime credential can select any transaction tenant context: this is a trusted-server boundary, **not** production authentication. PostgreSQL administrators can bypass RLS and edit audit data.
- CLI-only writes avoid an unauthenticated network write surface. The browser cannot manage persisted cases yet. Adding that surface requires a separate identity/authorization design.
- Explicit SQL makes grants and policies inspectable and avoids an ORM dependency, at the cost of hand-written migrations and validation.
- Logs use stable operation/outcome codes and correlation IDs. Raw database errors, URLs, passwords and command payloads are excluded. DBA-enabled bind-parameter logging can capture credential bootstrap values and must remain disabled for setup.
- Lists/history are capped at 100 rows for the local demo. Production pagination, concurrency/version conflicts, retention, backup/restore and audit tamper resistance remain future work.
- Local commands accept loopback database URLs only and refuse `NODE_ENV=production`. Compose has no cloud cost. CI uses an isolated disposable PostgreSQL service; integration tests must never reset the demonstration volume.

## Verification

Run lint, typecheck, unit/component coverage, build, real PostgreSQL integration tests and `git diff --check`. Integration tests use the actual restricted runtime login and cover role attributes, forced RLS, cross-tenant reads/writes, missing/malformed context, validation, audit atomicity, transaction rollback, pooled context cleanup and concurrent tenants. Security and release reviews remain explicit verification steps. No LLM, production authentication, public write API or cloud deployment is included.

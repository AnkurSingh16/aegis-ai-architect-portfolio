---
paths:
  - "apps/api/**"
---

# API rules

- Tenant identity comes from server-owned configuration or verified authorization, never from an arbitrary request value. A tenant path value selects a membership to check; it does not grant access.
- Authorization needs both the verified scope and the database membership role. Do not add a route that skips either.
- Database access uses the runtime role under forced RLS. Do not weaken a policy to make a test pass.
- Validate every external input with the existing schema or contract modules before use.
- Errors returned to clients must not reveal stack traces, SQL, tokens or other tenants' data.
- Focused check: `npm run test -w apps/api` (or a single test file). Full gates: see `.claude/CLAUDE.md`.
- Domain context: `.claude/context/api.md`, plus `identity.md` only if the change touches authentication.

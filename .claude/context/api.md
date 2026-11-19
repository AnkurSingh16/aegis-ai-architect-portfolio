# aegis/api

- Entry points: `apps/api/src/server.ts`, `app.ts`, `server-lifecycle.ts`. Triage logic: `triage.ts`. Demo route: `demo.ts`.
- Modules: `auth/` (JWT, memberships), `storage/` (tenant-scoped PostgreSQL access), `documents/` (ingestion), `contracts/` (request and response schemas), `ai/` (providers and analysis).
- Tenant scoping is server-owned. Storage uses forced RLS and transaction-local tenant context (see ADR 002 and 003).
- Scripts: `npm run dev -w apps/api`, `npm run test -w apps/api`, `npm run test:integration -w apps/api` (needs PostgreSQL), `npm run db:migrate -w apps/api`.
- Migrations are checksum-verified SQL with separate administrator and runtime roles.

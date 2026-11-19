# aegis/core

- Purpose: an auditable, multi-tenant support copilot for engineering-leadership portfolio review. Sourced answers, human review and approved escalation are the product themes.
- Layout: `apps/api` (Fastify, TypeScript), `apps/web` (React/Vite), `infra/terraform/auth0` and `infra/terraform/aws` (Terraform, offline validation only), `.github/workflows/ci.yml`.
- Accepted: the authenticated human-review MVP, per `docs/MVP-ACCEPTANCE-2026-11-15.md` and `docs/MVP-COMPLETION-AUDIT.md`. Verify the current wording there before quoting it.
- Roadmap and milestone history: `docs/ARCHITECTURE-ROADMAP.md`. Decisions: `docs/adr/` (002 to 008).
- Not verified here: the real Auth0 browser session and an authorized operator workflow (per the roadmap snapshot).

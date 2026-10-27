# Aegis AI — Enterprise AI Engineering Portfolio

An educational, production-minded portfolio foundation built with Node.js, TypeScript, React, Codex subagents, tests, CI and infrastructure-as-code planning.

> **Status:** This is an initial local starter, **not** a production-ready authenticated AI service. `/api/demo/query` returns synthetic mock responses; no OpenAI API, RAG, Auth0, tenant-isolation enforcement or production infrastructure is implemented yet.

## Start on an Apple Silicon Mac

See **[docs/MAC-SETUP.md](docs/MAC-SETUP.md)** first. The short path, once Node 24 LTS and GitHub are configured:

```bash
npm install
npm run dev
```

Open http://localhost:5173 in your browser. API health is at http://localhost:4000/api/health.

## Synthetic support triage

In the **Customer support case triage** section, choose a supplied synthetic case and select **Triage synthetic case**. React sends its allowlisted ID to Fastify, then displays category, priority, suggested team, rationale and a suggested next step. Changing cases clears the previous result. Failed requests can be retried; requests time out after ten seconds.

| Invented case | Category | Priority | Suggested team |
| --- | --- | --- | --- |
| Login outage | incident | high | Platform support |
| Duplicate invoice | billing | medium | Billing support |
| Documentation request | guidance | low | Customer support |

These are fixed fixture lookups, **not LLM inference or RAG**. Nothing is stored, sent to a support team, escalated, refunded or otherwise executed. The interface accepts no customer text. No paid service or credentials are needed.

`POST /api/demo/triage` accepts JSON containing exactly one supported case ID:

```json
{"caseId":"SYNTHETIC-LOGIN-001"}
```

The response contract contains `mode: "synthetic-mock"`, the same `caseId`, `category`, `priority`, `suggestedTeam`, `rationale`, `nextStep`, and an explicit synthetic warning. The shared dependency-free contract lives in `apps/api/src/contracts/triage.ts`; the browser validates the result before displaying it. Requests reject extra fields and incorrect types, with a 1 KiB body limit. Errors use stable messages: invalid requests return 400, oversized requests 413, unsupported media types 415, and unexpected failures 500.

**Local development only:** the API and Vite development server bind to loopback. Both demo API routes are absent when `NODE_ENV=production`; production frontend builds display a local-availability message instead of the triage form. Do not expose the unauthenticated development servers through a public proxy or tunnel. There is no authentication, tenant isolation, persistence, rate limiting or production support workflow. See [the triage design decision](docs/TRIAGE-DEMO-DECISION.md).

```bash
npm run lint
npm run typecheck
npm run test:coverage
npm run build
```

Open `apps/api/coverage/index.html` and `apps/web/coverage/index.html` for HTML coverage reports after running tests. Generated results are deliberately ignored by Git.

## What's included
- `apps/web`: React + Vite portfolio frontend, proxied to local API.
- `apps/api`: Fastify Node/TypeScript API with **synthetic local-only mock demo**.
- `docs/REACT-NATIVE-SETUP.md`: instructions for a future Expo / React Native app (not initialized yet).
- `.codex/agents`: architect, challenger, implementer, QA, security and release custom subagents.
- `.github/workflows/ci.yml`: lint, typecheck, tests, coverage upload, builds.
- `infra/terraform/aws`: draft non-applied Terraform infrastructure module.
- `docs`: decisions, local setup, release and architecture roadmap.

## Design principles
- Secure-by-default; never commit `.env` files, credentials or customer data.
- Design and skepticism before nontrivial changes; tests/reviews after changes.
- Use feature branches and pull requests; GitHub Actions gates quality.
- Do not deploy mock endpoints as if they were authenticated AI services.
- Add infrastructure only after cost review and explicit human approval.

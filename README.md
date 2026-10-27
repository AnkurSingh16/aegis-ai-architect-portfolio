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

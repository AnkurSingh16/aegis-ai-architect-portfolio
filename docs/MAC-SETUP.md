# Aegis AI — macOS local demo setup

This guide replaces the historical starter-zip setup. Use the [local demo runbook](LOCAL-DEMO-RUNBOOK.md) for service ownership, startup, authentication, review and shutdown boundaries.

## Requirements

- Apple Silicon or Intel macOS supported by Node.js 24
- Git and npm
- Docker Desktop only when the already-approved PostgreSQL service is unavailable and an operator has approved startup
- Existing local Auth0 development configuration for the protected browser experience

## Checkout and dependencies

```bash
git clone https://github.com/AnkurSingh16/aegis-ai-architect-portfolio.git
cd aegis-ai-architect-portfolio
git status --short --branch
npm ci
```

Do not overwrite a working checkout. For an existing clone, verify branch and uncommitted changes before switching or updating it.

## Read-only readiness checks

Before starting any process, inspect current owners and health:

```bash
/usr/sbin/lsof -nP -iTCP:4000 -iTCP:5173 -iTCP:5432 -iTCP:11434 -sTCP:LISTEN
curl --fail --silent --show-error http://127.0.0.1:4000/api/health
curl --fail --silent --show-error http://127.0.0.1:5173/
```

If a port already has a listener, identify its owner and follow the runbook. Do not start a duplicate API, stop PostgreSQL, restart Ollama, or delete Docker volumes to make the commands pass.

## Authenticated demo

The public portfolio can run without Auth0. Protected cases require a real Auth0 PKCE session and verified tenant membership. Public SPA settings belong only in ignored `apps/web/.env.local`; API issuer/audience and restricted runtime database URL belong in `.env.api`. Never load root administrator credentials into the API or print environment files/tokens.

The human-review interface can persist approve/reject/defer decisions. Treat each such submission as a database write requiring explicit authorization. The workflow does not change case status or execute downstream actions.

## Quality and browser test commands

```bash
npm run lint
npm run typecheck
npm run test:coverage
npm run test:e2e -w apps/web
npm run build
terraform -chdir=infra/terraform/auth0 fmt -check -recursive
```

The Playwright suite uses mocked identity and intercepted synthetic API responses; it is not a real Auth0 or database acceptance test. PostgreSQL integration runs only against isolated `aegis_test` in CI unless an operator separately verifies a disposable local test database. Never point migration/integration commands at `aegis_local`.

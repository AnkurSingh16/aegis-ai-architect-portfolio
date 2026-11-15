# Local Aegis demo runbook

This runbook is for the synthetic local demo only. It does not authorize database writes, migrations, Auth0 changes, live review submissions, AI inference, or process replacement. AI stays disabled unless separately approved.

## 1. Verify before starting anything

Use the approved repository and a clean checkout. Check which process owns each loopback port before starting a service:

```bash
git status --short --branch
git branch --show-current
git rev-parse HEAD
/usr/sbin/lsof -nP -iTCP:4000 -iTCP:5173 -iTCP:5432 -iTCP:11434 -sTCP:LISTEN
```

If port 4000 is already owned, identify its command and supervisor. Do not launch a duplicate API or signal an unidentified process. The API binds only to `127.0.0.1`; the operating system refuses a second listener on the same address/port. If the existing process is the Codex-supervised instance without a controllable graceful stop, leave it running and request operator help rather than replacing it.

Check Docker context and container health read-only before considering PostgreSQL startup:

```bash
docker context show
docker --context desktop-linux compose ps
docker --context desktop-linux ps
```

Do not create another database/container, stop a container, remove a volume, migrate, seed or ingest as part of demo setup. Request separate approval if PostgreSQL is unavailable.

## 2. Start the local API only when port 4000 is free

Use the restricted API configuration, never the root administrator `.env`. Keep AI disabled explicitly:

```bash
NODE_ENV=development AEGIS_AI_ENABLED=false AEGIS_GROUNDED_AI_ENABLED=false node --env-file=.env.api --import tsx apps/api/src/server.ts
```

Run it in an operator-controlled terminal so Ctrl-C reaches the API process. New source installs idempotent SIGINT/SIGTERM handlers that await `app.close()`; Fastify's close hook closes the connection pool. A shutdown error is logged using a fixed event and returns a nonzero process status. Do not apply this handler assumption to an already-running older process.

Check health and loopback binding in another terminal:

```bash
curl --fail --silent --show-error http://127.0.0.1:4000/api/health
/usr/sbin/lsof -nP -iTCP:4000 -sTCP:LISTEN
```

API readiness includes the startup hook that verifies the database runtime role and required forced-RLS/least-privilege checks. Health alone is not proof of authenticated authorization.

## 3. Start the web app only when port 5173 is free

```bash
npm run dev -w apps/web
```

The standard Vite server is strict on loopback port 5173 and proxies `/api` to `127.0.0.1:4000`. If another process owns the port, identify it first; do not stop or restart it without approval.

## 4. Auth0 and case access

The web app reads public SPA values from ignored `apps/web/.env.local`; the API reads issuer/audience and restricted `DATABASE_URL` from `.env.api`. Never expose either file, access tokens, or browser storage. Confirm presence/equality without printing values. The SPA requests `read:cases write:cases`; the API validates JWT signature, issuer, audience, time claims and scope, then checks verified issuer/subject tenant membership. PostgreSQL RLS remains an independent boundary.

Open `http://127.0.0.1:5173`. An operator must perform interactive Auth0 login and MFA. If sign-in fails or the account is not authorized, record the sanitized HTTP status and stop. Do not grant memberships or change Auth0 as a troubleshooting shortcut. Select only the account's authorized synthetic tenant; a denial on another tenant is expected and must not trigger a retry under another identity.

Human case review is a persistent database write. Only use Approve, Reject or Defer after the data owner explicitly authorizes a synthetic review submission. A review records a human decision and does not assert that an AI recommendation is correct, alter case status, or execute an external action.

## 5. Grounded analysis

The grounded path uses PostgreSQL English full-text retrieval and request-scoped source IDs. It is advisory, requires human review and may abstain or fail validation. Citation identity does not prove semantic entailment. Historical Qwen results do not establish consistent supported decisions. Keep both `AEGIS_AI_ENABLED` and `AEGIS_GROUNDED_AI_ENABLED` false for routine demos. Any future evaluation requires separate approval, a safe exclusive model window, a fresh absent report path and predeclared acceptance criteria. No cloud fallback or model download is supported.

## 6. Shutdown and troubleshooting

For a process started in the current terminal, use Ctrl-C and wait for the shutdown to finish. Do not use `kill -9`, blanket `pkill node`, `docker compose down`, or remove volumes. Verify only the process you started has exited. If its parent/supervisor owns lifecycle, use that supervisor's documented stop control; if none is available, stop and request operator guidance.

Common states:

- **API health 200 but protected route 401:** API is reachable; authenticate in the browser.
- **403:** scope, membership or role does not authorize this tenant/action. Do not change identity state without approval.
- **503 on AI route:** AI may be disabled or local Ollama unavailable; do not enable it or restart Ollama without approval.
- **Port already allocated:** leave the listener intact and identify its owner before any action.
- **Runtime role check fails:** do not use admin credentials in the API or weaken the verifier.

Automated E2E tests use a separate test-only Vite configuration with mocked Auth0 and intercepted synthetic API responses. They do not perform real Auth0 login, DB access or model inference.

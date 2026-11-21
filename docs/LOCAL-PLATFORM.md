# AEGIS local platform: runbook and verified status

Scope of this document: the local deployment of the production-intended components that exist today. It records what runs, how it was verified, and what is not yet done. It does not claim production readiness.

Branch: `local-platform-p1`, based on `production-local-plan` (plan documents on top of `origin/c10-security-hardening`). It does not include C6 (PR #76) or C8 (PR #77).

## 1. What runs locally

Compose project `aegis-local` (its own network and volumes; no other project's containers or data are used or stopped).

| Service | Image (pinned) | Role | Host port (loopback only) |
| --- | --- | --- | --- |
| `postgres` | `pgvector/pgvector:pg17` (digest `sha256:ac08538c…2c22a75d`, arm64) | Application database with RLS | 55432 |
| `keycloak-db-init` | built from the same pinned pgvector base | One-shot: creates Keycloak's role and database | none |
| `keycloak` | `quay.io/keycloak/keycloak:26.4` (digest `sha256:9409c59b…e6007`, arm64) | Local OIDC identity provider, realm `aegis` | 8180 |
| `migrate` | built from `apps/api/Dockerfile` (node 24 bookworm slim, digest `sha256:dc26ae92…061c54`) | One-shot migration job, development-only role | none |
| `api` | same API image | Fastify API, `NODE_ENV=production` | 4110 |
| `web` | built from `apps/web/Dockerfile` (nginx 1.27 alpine, digest `sha256:65645c7b…2f2a10`) | Static web build; proxies `/api` to the API service | 5190 |
| `otel-collector` | `otel/opentelemetry-collector:0.165.0` (digest `sha256:34b24b74…ed1b73`, arm64) | OpenTelemetry Collector: OTLP/HTTP receiver, debug exporter (no host port) | none |

Port choices: 4100 and 5180 were not free on this machine (a different project's `node` process holds 4100 and was not touched). The defaults in `.env.local` are 4110, 5190 and 8180.

## 2. Commands

```bash
node scripts/local-stack.mjs init     # creates .env.local with generated secrets (0600); adds only missing entries
node scripts/local-stack.mjs up       # builds images and starts services; waits for health
node scripts/keycloak-setup.mjs       # idempotent: realm scopes, client secrets, synthetic users, memberships
node scripts/local-stack.mjs verify   # liveness, readiness, web shell, proxy, anonymous refusal
node scripts/local-stack.mjs drill    # stops only PostgreSQL, checks 503 and recovery, restarts the API
node scripts/e2e-auth.mjs             # 14 real-token checks over HTTP to the API container
node scripts/e2e-auth.mjs --rotate    # also rotates the realm signing key and records the timings
node scripts/telemetry-check.mjs    # traces, metrics, log correlation and the export allowlist
npm run test:stack                    # opt-in: all of the above plus the browser suite (exit 0 = pass)
node scripts/local-stack.mjs status   # service states
node scripts/local-stack.mjs down     # stops and removes containers and networks. Never removes volumes
```

`down` deliberately has no volume option. Removing the `aegis-local` volumes is a manual, separately approved step.

## 3. Trust boundaries (as implemented)

- **Ports.** Every published port is bound to `127.0.0.1`. The API listens on `0.0.0.0` only inside its container namespace (`AEGIS_API_HOST`). The default outside a container is still `127.0.0.1`, and the value must be an IP literal.
- **Container hardening.** The API runs as the `node` user with a read-only root filesystem, `cap_drop: ALL`, and `no-new-privileges`. Keycloak drops all capabilities. nginx keeps only `CHOWN`, `SETGID` and `SETUID`, which it needs to start.
- **Database.** The migrator is the only holder of the administrator URL, and it refuses `NODE_ENV=production` by design. The API connects as `aegis_app`, which has no schema creation, no membership writes and no direct access to the migration history. The runtime role can call one function, `aegis_migrations.applied_versions()` (migration 014), which returns only version names.
- **Database host guard.** A non-loopback host is accepted only when `AEGIS_ENVIRONMENT=local` and the name is in `AEGIS_ALLOWED_DATABASE_HOSTS`. Production configuration is not changed by this.
- **OIDC issuer.** The issuer must match the `iss` claim exactly. Production requires HTTPS, a registered name and no IP literal. Plain HTTP is accepted only for a loopback host when `AEGIS_ENVIRONMENT=local`. This is verified by unit tests.
- **Key lookup.** An explicit JWKS URL is used when configured. Otherwise, OpenID Connect discovery is used, and the document's `issuer` must equal the configured issuer exactly. Redirects are refused. The JWKS URL follows the same URL rules as the issuer.
- **Named service hosts.** Plain HTTP to a named service (here `keycloak`, for the JWKS) is accepted only in a local deployment and only when listed in `AEGIS_ALLOWED_SERVICE_HOSTS`.
- **Secrets.** Generated locally into `.env.local` (0600, git-ignored). Never printed by any script. Never committed. The realm file contains no secrets. Test users have synthetic names and synthetic email addresses.
- **Test-only paths.** The direct-grant client (`aegis-test-client`) and the short-lived client exist only in this local realm, for acceptance tests. The realm file says so. They must not appear in any production realm.

## 4. Verified evidence (commit recorded in the pull request)

| Check | Command | Result |
| --- | --- | --- |
| Liveness, readiness, web shell, proxy, anonymous refusal | `verify` | 6 of 6 PASS |
| Database outage: readiness 503 with reason; liveness 200; proxy 503; recovery after restart of PostgreSQL and of the API | `drill` | every check PASS on the rebuilt stack |
| Migrations: first run applied 13, later run applied 0 (idempotent). A later run after migrations 014 and 015 applied 2 | `migrate` logs | PASS |
| Real OIDC tokens: issuer, audience, subject and scope claims; member accepted; other tenant, no membership, missing scope refused; anonymous refused; tampered payload refused; `alg: none` refused; token signed by an unpublished key refused; token expired after three seconds refused; token accepted before expiry | `e2e-auth.mjs` | 14 of 14 PASS, repeated twice with the same result |
| Signing-key rotation: new realm key added; token signed by it accepted after 14 s (JWKS refresh cooldown); old key retired | `e2e-auth.mjs --rotate` | PASS; see limitation L3 |
| Repository unit suite | `npx vitest run` in `apps/api` | 107 files, 1022 tests, all passing |
| Repository integration suite (disposable PostgreSQL 17) | `npx vitest run -c vitest.integration.config.ts` in `apps/api` | 15 files passing, 159 tests passing, 10 live-model tests skipped |
| Readiness and database-guard tests | included above | 3 integration and 4 unit tests |
| Lint, typecheck | `npm run lint`, `npm run typecheck` | clean |

Notes on the evidence:
- The acceptance tests call the real Keycloak token endpoint and send the tokens to the API container. None of them is mocked.
- The first run of `e2e-auth.mjs` after a stack rebuild failed at its first token request, while Keycloak was restarting as part of `up`. Three later runs passed. The cause was not investigated beyond that timing.
- The rotation run leaves the realm with one more signing key each time it is run.

### 4.1 Web sign-in and telemetry (added after the P2 checkpoint)

| Check | Result |
| --- | --- |
| Full stack acceptance (`npm run test:stack`), two consecutive runs | exit 0 in both; identical step results |
| Health and readiness (`verify`) | 6 of 6 PASS |
| Authentication with real tokens (`e2e-auth`) | 14 of 14 PASS |
| Telemetry (`telemetry-check`) | 12 of 12 PASS |
| Browser lifecycle, production build, interactive sign-in (Playwright, Chromium) | 10 of 10 PASS in both runs |
| Signing-key rotation with emergency retirement (`e2e-auth --rotate`) | retired key's token refused after 55 s (policy 60 s) |
| Unit: API / web | 1022 / 69 passing |
| Integration (disposable PostgreSQL 17) | 159 passing, 10 live-model skipped |
| Lint, typecheck, production build | clean |

The browser suite exercises the real login page at `localhost:8180`, PKCE, the callback, a forged state, sign-out, a stopped identity provider (with recovery), token renewal after the 60-second lifetime, and an API restart with silent restore.

## 5. Defects found and fixed during this work

1. The verifier derived the key URL as `issuer + /.well-known/jwks.json`, which Keycloak does not serve. Replaced with discovery and an explicit JWKS override.
2. Issuer validation rejected paths and ports, which OpenID Connect allows and Keycloak uses. Now validated against the standard rules.
3. Imported Keycloak clients did not receive the `basic` scope, so tokens had no `sub` claim, and the verifier correctly refused them. Fixed by declaring the scope in the realm and assigning it to clients.
4. The audience mapper was attached to the optional `read:cases` scope, so a token that did not request that scope was not addressed to the API. The audience now comes from its own default scope.
5. nginx could not start under `cap_drop: ALL`. Restored the three capabilities it needs.
6. A stale API container still held the old configuration after compose changed. Recreating the container corrected it.
7. The first migration design granted the runtime role `SELECT` on the migration history. An existing security test correctly refused it. Replaced with a narrow function (014) and a revoke of the stale grant (015).

## 6. Limitations and open items

- **Browsers.** Only Chromium is tested. Other browsers' third-party cookie policies can stop silent renewal and restore. Not verified (see `docs/WEB-AUTHENTICATION.md`).
- **Access tokens are not revocable immediately.** A retired signing key or an ended session takes effect within the 60 s key-set and token window. See `docs/KEY-ROTATION-POLICY.md`.
- **Availability trade-off.** If the identity provider's key endpoint is unavailable for longer than the cache window, every token is refused. This is fail-closed by decision. A different trade-off needs the owner's decision.
- **Keycloak runs in start mode over HTTP on loopback.** Local only. Production needs HTTPS and its own hostname configuration.
- **Compose is run by an opt-in manual workflow only.** `.github/workflows/stack-acceptance.yml` is `workflow_dispatch`. It is not a pull request check.
- **Telemetry.** Traces and metrics go to a Collector with a debug exporter. No backend, dashboards or retention. Logs are JSON on stdout, not exported over OTLP. See `docs/OBSERVABILITY.md` section 6.
- **The Collector's receiver has no authentication.** Reachable from the compose network only. Production needs authenticated transport, which depends on workload identity (P3).
- **Not built yet:** SPIRE workload identity and mTLS (P3), the PostgreSQL outbox (P5), durable multi-agent state (P4), and agent-execution telemetry.
- **No independent review** of any of this.

## 7. What would change when promoted (configuration, not code)

- Issuer: HTTPS identity provider URL in `OIDC_ISSUER`, with discovery (no `OIDC_JWKS_URI`).
- Web runtime configuration: the same image with production values in `AEGIS_WEB_*` (no rebuild).
- Telemetry: the collector endpoint changes to a reviewed, authenticated destination; the allowlist stays.
- `AEGIS_ENVIRONMENT`: unset, which selects the strict production rules.
- Database: a managed PostgreSQL with TLS; the host guard then needs a reviewed production path, which this change does not provide.
- Keycloak: replaced by the chosen production identity platform; no code change, only configuration and the test-client removal.
- Images: pushed to a registry under a reviewed tag and digest, not built on the workstation.

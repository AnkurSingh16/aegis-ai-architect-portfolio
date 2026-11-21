# Signing-key rotation and emergency retirement policy

Status: implemented and tested against the local Keycloak realm (`scripts/e2e-auth.mjs --rotate`). Production values are a configuration decision and need review.

## 1. Mechanisms (what the verifier does)

- The API fetches the realm's published key set (JWKS) through an explicit `OIDC_JWKS_URI` or through OIDC discovery, with an exact issuer check.
- The key set is cached for at most **60 s** (`cacheMaxAge`, `apps/api/src/auth/token.ts`). A key that the provider stops publishing is therefore refused within that window.
- A token whose `kid` is not in the cached set triggers a refresh, at most once per **30 s** (`cooldownDuration`).
- Tokens are checked for signature (RS256 only), issuer, audience, subject and expiry on every request.

## 2. Normal rotation

1. Add a new signing key with a higher priority. It becomes the signer for new tokens. The old key stays published (passive), so tokens it already signed still verify.
2. Wait for the overlap, which must be at least the access-token lifetime (60 s here, 300 s in the default realm) plus the 60 s cache window.
3. Retire the old key (section 3) when no tokens signed by it should remain in use.

Keycloak keeps passive keys in the published set on purpose. Setting only `active=false` does not retire a key.

## 3. Emergency retirement (suspected compromise)

1. Identify the key from the `kid` of a suspect token. The realm key listing maps `kid` to its key component.
2. Set the component to `enabled=false` and `active=false`. Keycloak removes it from the published set.
3. Within 60 s, the API refuses tokens signed by that key. Measured: **refused after 55 s** in `e2e-auth.mjs --rotate`.
4. End the affected user sessions at the provider. Renewal then fails, and the user must sign in again.

## 4. What this policy does not guarantee

- **Immediate revocation is not claimed.** A still-valid access token signed by a retired key is accepted for up to 60 s after retirement. An access token issued before a session is ended is accepted until it expires, for the same reason.
- **Availability trade-off.** The cache is refreshed when it expires. If the provider's key endpoint is unreachable for longer than the cache window, verification fails and the API refuses all tokens (`Authentication required.`) until the endpoint returns. The 60 s setting is fail-closed. A stale-while-unavailable mode would extend availability but would also extend the window for a retired key. This is recorded as a decision for the owner, not a silent default.
- **Performance cost.** The steady-state cost is at most one key-set request per process per minute, plus refreshes for unknown `kid` values at most once per 30 s. Measured on the local stack: a new key was accepted within 14 s of creation in the first run and at once in a later run, both with the 30 s cooldown in place.

## 4.1 Decision: fail closed, no stale-key acceptance (2026-11-21)

The owner decided to keep the 60 s cache and fail-closed behaviour. Stale signing keys are not accepted to improve availability. Measured with `npm run test:availability` (identity provider stopped, then restarted, on the local stack):

| Observation | Measured |
| --- | --- |
| Held token (valid by its own expiry) accepted during the outage | yes, for the first 61 s of the outage window (11 of 22 samples) |
| First refusal of the held token after the identity provider stopped | 61 s (policy bound: about 60 s after the last successful key fetch) |
| After refusal began | refused on every later sample (fail closed) |
| Unauthenticated endpoints (`/api/health`, `/api/ready`) during the outage | 200 throughout |
| Anonymous protected request during the outage | 401 |
| New token accepted after the identity provider returned | 11 s after restart |

Security cost: a token remains usable for up to about 60 s after the key set is no longer obtainable, and a retired key is still accepted until the cache expires.
Availability cost: while the identity provider is unreachable, every protected request fails once the cache expires. Unauthenticated endpoints and the database-backed readiness check are unaffected.

Operational procedure:
1. Monitor: the alert `AegisIdentityRefusalsElevated` (provisional threshold, see docs/OBSERVABILITY.md) fires on sustained identity-verification refusals.
2. Recover: restore the identity provider. The API recovers within one cache window after the key set is reachable again. No API restart is required.
3. Do not restart the API to force recovery. It does not change the outcome and it drops in-flight requests.
4. Immediate revocation is not available. To stop a compromised key, follow section 3 (disable the key). Acceptance ends within 60 s.

## 5. Evidence (local, Keycloak 26.4)

| Step | Result | Command |
| --- | --- | --- |
| New key accepted | accepted within 14 s (first run), 0 s (later run) | `node scripts/e2e-auth.mjs --rotate` |
| Old key disabled, identified by `kid` | PASS (status ACTIVE before disabling) | same |
| Token signed by the disabled key | refused after 55 s (policy: within 60 s) | same |

The earlier implementation set only `active=false`. That left the old key published, and the old token kept working for the whole observation window. The check caught it, and the policy above corrects it.

## 6. Key lifecycle hygiene

Each `--rotate` run adds one key. Stale passive keys from earlier runs remain published until they are removed. Removing a passive key is a retirement and follows section 3. A scheduled cleanup is not implemented.

# Web authentication: design, storage and renewal strategy

Status: implemented and verified locally against Keycloak 26.4 with the production build of the web application. Browser acceptance is recorded in `docs/LOCAL-PLATFORM.md`. Not independently reviewed.

## 1. What the browser does

- **Flow:** OpenID Connect Authorization Code with PKCE (S256), a public client (`aegis-web`). The browser never holds a client secret and never uses the implicit flow or the resource-owner password grant.
- **Library:** `oidc-client-ts` 3.5.0 (protocol handling) with `react-oidc-context` 3.3.1 (React integration). Both are pinned exactly. Only `apps/web/src/auth/session.tsx` depends on them. Components use the provider-neutral `useSession()` hook.
- **Validation:** the library checks `state`, `nonce` and the PKCE verifier on the callback. The application validates the deployment configuration before use (section 3).
- **API calls:** each request carries `Authorization: Bearer <access token>` from `getAccessToken()`. The token is obtained from memory, renewed if it is near expiry, and never placed in a URL.

## 2. Storage and renewal policy

| Material | Where it lives | Why |
| --- | --- | --- |
| Access token | Memory only (`InMemoryWebStorage`) | Not persisted. A page reload discards it and the session is restored silently (section 2.1). |
| Refresh token | Not requested by the browser client | Refresh tokens persisted in a browser are a larger theft target. Renewal uses a silent `prompt=none` request instead. |
| PKCE verifier, state and nonce | `sessionStorage` (tab-scoped), removed when the callback completes | They must survive the redirect to the identity provider and back. The library's default. |
| Session cookie | Identity provider domain only | Not readable by the application. |
| Configuration | Served as `/config.json`, `Cache-Control: no-store` | Public values only (section 3). |

Nothing is written to `localStorage`. No token appears in a URL, a log line or a page.

### 2.1 Restore, renewal and expiry

- **On load:** if no callback parameters are present and the library is initialised, one silent sign-in (`prompt=none`) restores an existing identity-provider session. "Not signed in" is a normal result and shows the sign-in button. It is not an error.
- **Before expiry:** the library renews automatically through a hidden frame that loads `/silent-renew.html` (a separate build entry). `getAccessToken()` also renews when a token is within 30 s of expiry.
- **Renewal failure:** the session ends and the user signs in again. The UI does not retry silently in a loop.
- **Lifetime:** the browser client's access tokens last 60 s in this realm (`access.token.lifespan`). That keeps expiry and renewal observable in tests. Production lifetimes are a configuration decision.

### 2.2 Same-site requirement

Silent renewal and restore need the identity provider's session cookie in the hidden frame. The browser treats `localhost` and `127.0.0.1` as different sites. The local deployment therefore uses `localhost` for the web origin and the identity provider. The redirect URIs, the web origins and the browser tests all use `localhost`. `127.0.0.1` is not used for authentication. The browser suite passes restore and renewal, which confirms the same-site choice rather than assuming it. Chromium's default third-party cookie setting was used. Other browsers' cookie policies were not tested (section 6).

## 3. Configuration contract

Public browser configuration, delivered at runtime (`/config.json`) by an entrypoint script in the web image. Changing an environment variable and restarting the web container changes the deployment without rebuilding.

| Field | Meaning | Rule |
| --- | --- | --- |
| `environment` | `local`, `staging` or `production` | Selects the issuer rules. |
| `issuer` | Exact OIDC issuer identifier | Must be the canonical spelling. `https` unless `local` and a loopback host. |
| `clientId` | Public client identifier | Pattern-checked. No secret field exists. |
| `audience` | Expected API audience | Checked by the API. Shown for diagnostics only. |
| `scopes` | Requested scopes | Must include `openid`. Maximum 10. |
| `redirectPath`, `postLogoutRedirectPath` | Paths on the application origin | Absolute URLs, protocol-relative paths and queries are refused. Callbacks cannot leave the origin. |
| `apiBasePath` | Always `/api` | Cross-origin API calls are refused by the contract. |
| `silentRenew` | Boolean | Enables section 2.1. |
| `features.demoRoutes` | Boolean, default `false` | Development demonstrations are off unless explicitly enabled. Authorisation never depends on the build mode. |

The browser never chooses an identity provider and never accepts a JWKS location from the page. The API independently trusts only its own configured issuer (`OIDC_ISSUER`), and it fetches keys from `OIDC_JWKS_URI` (or discovery) with an exact issuer check.

Production secrets never reach the browser or the web tier. The web tier receives only the public values above.

## 4. Failure states

| Situation | What the user sees | Source |
| --- | --- | --- |
| Anonymous visitor | Sign-in button; no protected data; no protected API call | `session.tsx` status `anonymous` |
| Identity provider unreachable at sign-in | "The identity provider is unavailable. Try again when it is back." | Error kind `provider_unavailable` |
| Callback with invalid or forged state | "Sign-in could not be completed. Start sign-in again." The code and state are removed from the address bar | Error kind `callback_failed` |
| Expired access token | Renewed silently; if renewal fails, signed out and asked to sign in | `getAccessToken()` |
| Revoked or ended identity-provider session | Silent restore returns "not signed in"; the user signs in again | `prompt=none` returns `login_required` |
| Member requests another tenant | Tenant access denied; no cases from that tenant are shown | API `403`, shown in the tenant panel |
| Reader attempts a review decision | Decision controls are not offered; a direct request is refused by the API | UI gating plus API `403` |

## 5. Threat model (summary)

- **Cross-site scripting** can read in-memory tokens while the page is open. Mitigations: no third-party scripts, strict configuration validation, no `innerHTML` for tokens, short access-token lifetime. Not fully mitigated: a content security policy is not yet deployed (see section 6).
- **Token theft from storage:** no tokens are stored persistently. A stolen `sessionStorage` PKCE verifier is useless without the authorisation code.
- **Open redirect and code injection:** redirect and logout targets must be on the application origin and must not carry query strings.
- **Client impersonation:** the client is public and cannot prove identity. It is protected by PKCE, exact redirect URIs and the identity provider's client policy.
- **Revocation:** ending the identity-provider session prevents renewal. An access token already issued remains valid at the API until it expires (up to 60 s here). Immediate revocation of access tokens is not claimed.

## 6. Limitations and not tested

- Only Chromium (Playwright) was tested. Safari and Firefox partition or block third-party cookies differently, which can stop the hidden renewal frame. Those cases are not verified.
- No content security policy is deployed yet.
- The browser client is public and reauthenticates when renewal fails. Offline or long-lived sessions are not supported.
- Interrupted authentication (the user closing the window mid-login) is covered by the state check on return, but was not separately automated.
- Insufficient-scope responses cannot be distinguished from tenant denial in the UI, because the API returns `403` for both. The scope-specific behaviour is verified at the API level by `scripts/e2e-auth.mjs`.

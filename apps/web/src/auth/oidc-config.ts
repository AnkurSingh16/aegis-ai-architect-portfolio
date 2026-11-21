/**
 * Provider-neutral OIDC configuration for the browser. The contract is the same for Keycloak locally and for any standards-compliant
 * identity provider later. Only the values change between environments.
 *
 * The browser never chooses its own identity provider. It accepts exactly one issuer, one client and one API base URL, all delivered
 * by the deployment as public configuration (no secrets). Redirect and logout URLs must be on the application's own origin, which
 * prevents an open redirect. Nothing here is a credential.
 */

export type DeploymentEnvironment = 'local' | 'staging' | 'production';

export interface OidcSettings {
  readonly environment: DeploymentEnvironment;
  /** The exact issuer identifier. It must equal the `iss` claim of tokens the API accepts. */
  readonly issuer: string;
  /** Public client identifier. The browser client is a public client: it holds no secret. */
  readonly clientId: string;
  /** The API audience that tokens must carry (checked by the API; shown here for the UI's own diagnostics). */
  readonly audience: string;
  readonly scopes: readonly string[];
  readonly redirectPath: string;
  readonly postLogoutRedirectPath: string;
  /** Relative API base. Cross-origin API calls are not permitted by this contract. */
  readonly apiBasePath: '/api';
  /** Automatic silent renewal through a prompt=none request. Needs the identity provider to be same-site with the application. */
  readonly silentRenew: boolean;
  /** Feature switches. Anything not listed is off. Development demonstrations are off unless explicitly enabled. */
  readonly features: { readonly demoRoutes: boolean };
}

export interface RuntimeConfig {
  readonly version: 1;
  readonly oidc: OidcSettings | null;
}

export class ConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigurationError';
  }
}

const ENVIRONMENTS: readonly string[] = ['local', 'staging', 'production'];
const SCOPE_TOKEN = /^[A-Za-z0-9:_.-]{1,64}$/;
const CLIENT_ID = /^[A-Za-z0-9._-]{1,200}$/;

function fail(field: string): never {
  throw new ConfigurationError(`Invalid authentication configuration: ${field}.`);
}

function isLoopback(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
}

/** OIDC issuer rules: exact canonical form, no userinfo, query or fragment; https outside a local environment. */
export function validateIssuer(value: unknown, environment: DeploymentEnvironment): string {
  if (typeof value !== 'string' || value.length > 255) fail('issuer');
  let url: URL;
  try { url = new URL(value as string); } catch { return fail('issuer'); }
  if (url.href !== value || url.username || url.password || url.search || url.hash) fail('issuer');
  const secure = url.protocol === 'https:';
  const localPlain = url.protocol === 'http:' && environment === 'local' && isLoopback(url.hostname);
  if (!secure && !localPlain) fail('issuer');
  return value as string;
}

function validateRedirectPath(value: unknown): string {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//') || value.length > 200) fail('redirect path');
  if (value.includes('?') || value.includes('#') || /[\s\\]/.test(value)) fail('redirect path');
  return value;
}

function validateScopes(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 10) fail('scopes');
  const scopes = value as unknown[];
  if (!scopes.every((scope) => typeof scope === 'string' && SCOPE_TOKEN.test(scope))) fail('scopes');
  if (!scopes.includes('openid')) fail('scopes');
  return [...new Set(scopes as string[])];
}

/**
 * Parses the runtime configuration served next to the application. Missing or disabled configuration yields `oidc: null`, which means
 * sign-in is unavailable in this deployment. A malformed configuration throws, so the application fails closed rather than guessing.
 */
export function parseRuntimeConfig(raw: unknown): RuntimeConfig {
  if (typeof raw !== 'object' || raw === null || (raw as { version?: unknown }).version !== 1) fail('version');
  const body = raw as { oidc?: unknown };
  if (body.oidc === undefined || body.oidc === null) return { version: 1, oidc: null };
  if (typeof body.oidc !== 'object') fail('oidc');
  const oidc = body.oidc as Record<string, unknown>;
  if (typeof oidc.environment !== 'string' || !ENVIRONMENTS.includes(oidc.environment)) fail('environment');
  const environment = oidc.environment as DeploymentEnvironment;
  if (typeof oidc.clientId !== 'string' || !CLIENT_ID.test(oidc.clientId)) fail('client identifier');
  if (typeof oidc.audience !== 'string' || oidc.audience.length === 0 || oidc.audience.length > 255 || oidc.audience.trim() !== oidc.audience) {
    fail('audience');
  }
  if (oidc.apiBasePath !== '/api') fail('API base path');
  if (typeof oidc.silentRenew !== 'boolean') fail('silent renew');
  const features = (oidc.features ?? {}) as Record<string, unknown>;
  return {
    version: 1,
    oidc: {
      environment,
      issuer: validateIssuer(oidc.issuer, environment),
      clientId: oidc.clientId,
      audience: oidc.audience,
      scopes: validateScopes(oidc.scopes),
      redirectPath: validateRedirectPath(oidc.redirectPath),
      postLogoutRedirectPath: validateRedirectPath(oidc.postLogoutRedirectPath),
      apiBasePath: '/api',
      silentRenew: oidc.silentRenew,
      features: { demoRoutes: features.demoRoutes === true },
    },
  };
}

/** The static silent-renewal page. It is a separate build entry that uses the same configuration. */
export const SILENT_RENEW_PATH = '/silent-renew.html';

/** The UserManager settings for the chosen settings. The redirect targets are absolute and on the application's own origin. */
export function userManagerSettings(settings: OidcSettings, origin: string) {
  return {
    authority: settings.issuer,
    client_id: settings.clientId,
    redirect_uri: new URL(settings.redirectPath, origin).href,
    silent_redirect_uri: new URL(SILENT_RENEW_PATH, origin).href,
    post_logout_redirect_uri: new URL(settings.postLogoutRedirectPath, origin).href,
    response_type: 'code',
    scope: settings.scopes.join(' '),
    automaticSilentRenew: settings.silentRenew,
    loadUserInfo: false,
    monitorSession: false,
    accessTokenExpiringNotificationTimeInSeconds: 30,
  } as const;
}

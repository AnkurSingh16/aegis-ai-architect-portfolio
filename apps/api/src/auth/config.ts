export interface AuthConfig { issuer: string; audience: string; databaseUrl: string; jwksUri?: string }

const LOOPBACK_HOSTS: readonly string[] = ['localhost', '127.0.0.1', '[::1]'];

function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code <= 0x1f || code === 0x7f;
  });
}

/** Local development only: plain HTTP to a loopback address, and only when the deployment declares itself local. */
function isLocalLoopback(url: URL, env: NodeJS.ProcessEnv): boolean {
  return env.AEGIS_ENVIRONMENT === 'local' && url.protocol === 'http:' && LOOPBACK_HOSTS.includes(url.hostname);
}

/** Named local services allowed for plain HTTP inside the local compose network, for example a Keycloak JWKS endpoint. */
function isLocalServiceHost(url: URL, env: NodeJS.ProcessEnv): boolean {
  const named = (env.AEGIS_ALLOWED_SERVICE_HOSTS ?? '').split(',').map((name) => name.trim()).filter(Boolean);
  return env.AEGIS_ENVIRONMENT === 'local' && url.protocol === 'http:' && named.includes(url.hostname);
}

/**
 * Validates an OIDC issuer identifier. Per OpenID Connect Core, the issuer is an https URL with no query or fragment and no user
 * information. It may include a port and a path (for example a realm-specific Keycloak issuer). The value must be the canonical
 * serialisation of the URL, because the verifier compares it exactly with the `iss` claim.
 *
 * Production (any environment other than `local`) requires https, a registered DNS name, and no IP literal. Plain HTTP is accepted
 * only for a loopback host when AEGIS_ENVIRONMENT=local. No certificate check is disabled anywhere: the local branch involves no TLS,
 * and the production branch trusts exactly what it trusted before.
 */
export function validateIssuer(value: string, env: NodeJS.ProcessEnv = process.env): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('Invalid authentication configuration.'); }
  const localHttp = isLocalLoopback(url, env);
  const production = url.protocol === 'https:' && !url.hostname.endsWith('.localhost') && url.hostname !== 'localhost'
    && !/^[\d.]+$/.test(url.hostname) && !url.hostname.includes(':');
  if (!(localHttp || production)
    || url.username || url.password || url.search || url.hash
    || url.href !== value || value.length > 255) throw new Error('Invalid authentication configuration.');
  return value;
}

/**
 * Validates a JWKS URL that is configured explicitly. Production requires https. Plain HTTP is accepted only in a local deployment, for
 * a loopback host or a named service listed in AEGIS_ALLOWED_SERVICE_HOSTS (the container network of the local stack).
 */
export function validateJwksUri(value: string, env: NodeJS.ProcessEnv = process.env): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('Invalid authentication configuration.'); }
  if (!(url.protocol === 'https:' || isLocalLoopback(url, env) || isLocalServiceHost(url, env))
    || url.username || url.password || url.search || url.hash || value.length > 512) {
    throw new Error('Invalid authentication configuration.');
  }
  return value;
}

export function resolveAuthConfig(env: NodeJS.ProcessEnv): AuthConfig | undefined {
  // OIDC_* is the provider-neutral name. AUTH0_* is accepted as a legacy alias for the same settings.
  const issuer = env.OIDC_ISSUER ?? env.AUTH0_ISSUER;
  const audience = env.OIDC_AUDIENCE ?? env.AUTH0_AUDIENCE;
  const jwksUri = env.OIDC_JWKS_URI;
  const databaseUrl = env.DATABASE_URL;
  if (issuer === undefined && audience === undefined) return undefined;
  if (!issuer || !audience || audience.length > 255 || audience.trim() !== audience
    || /\s/.test(audience) || hasControlCharacter(audience) || !databaseUrl) throw new Error('Invalid authentication configuration.');
  return {
    issuer: validateIssuer(issuer, env),
    audience,
    databaseUrl,
    ...(jwksUri === undefined ? {} : { jwksUri: validateJwksUri(jwksUri, env) }),
  };
}

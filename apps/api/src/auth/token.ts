import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';
import type { AuthConfig } from './config.js';
import { validateIssuer, validateJwksUri } from './config.js';
import { metrics } from '@opentelemetry/api';
import { logEvent } from '../observability/log.js';

// Identity outcomes as a metric. Attributes carry the outcome only: never a subject, a token or a claim value.
const identityOutcomes = metrics.getMeter('aegis-api').createCounter('aegis.identity.verifications', {
  description: 'Bearer token verification outcomes',
});

// Key-set policy. A retired signing key is refused once the cached set expires, so the cache bounds the window in which a retired key
// is still accepted: 60 s. Refresh after an unknown key identifier is allowed once per 30 s. This is the cost of prompt key retirement:
// at most one JWKS request per process per minute in steady state. Immediate revocation is not claimed (see docs/KEY-ROTATION-POLICY.md).
const JWKS_OPTIONS = { timeoutDuration: 5000, cooldownDuration: 30000, cacheMaxAge: 60000 } as const;
const DISCOVERY_TIMEOUT_MS = 5000;
const DISCOVERY_MAX_BYTES = 65536;

/**
 * OpenID Connect Discovery: fetches `<issuer>/.well-known/openid-configuration`, requires the document's `issuer` to equal the configured
 * issuer exactly, and returns its `jwks_uri` after the same URL rules as an explicit JWKS setting. Redirects are refused, so a
 * response cannot move the key lookup to another origin.
 */
export async function discoverJwksUri(issuer: string, fetchImpl: typeof fetch = fetch): Promise<string> {
  const response = await fetchImpl(`${issuer.replace(/\/$/, '')}/.well-known/openid-configuration`, {
    redirect: 'error', signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS), headers: { accept: 'application/json' },
  });
  if (!response.ok) throw new Error('Identity discovery failed.');
  const body = await response.text();
  if (body.length > DISCOVERY_MAX_BYTES) throw new Error('Identity discovery failed.');
  const document = JSON.parse(body) as { issuer?: unknown; jwks_uri?: unknown };
  if (document.issuer !== issuer || typeof document.jwks_uri !== 'string') throw new Error('Identity discovery failed.');
  return validateJwksUri(document.jwks_uri);
}

/**
 * Key lookup for the verifier. The key set is resolved on first use and retried after a failure. The JWKS fetch itself is delegated to
 * jose, which verifies signatures with the returned keys. Nothing here weakens signature verification.
 */
export function keysFromProvider(config: { readonly issuer: string; readonly jwksUri?: string },
  fetchImpl: typeof fetch = fetch): JWTVerifyGetKey {
  let resolved: ReturnType<typeof createRemoteJWKSet> | Promise<ReturnType<typeof createRemoteJWKSet>> | undefined;
  const jwks = () => {
    if (!resolved) {
      const uri = config.jwksUri === undefined ? discoverJwksUri(config.issuer, fetchImpl) : Promise.resolve(config.jwksUri);
      resolved = uri.then((location) => createRemoteJWKSet(new URL(location), JWKS_OPTIONS)).catch((error: unknown) => {
        resolved = undefined;
        throw error;
      });
    }
    return resolved;
  };
  return async (header, token) => {
    const set = await jwks();
    return set(header, token);
  };
}

export class AuthorizationError extends Error {
  constructor(public readonly status: 401 | 403) {
    super(status === 401 ? 'Authentication required.' : 'Access denied.');
  }
}
/** observe:metrics is a dedicated operator permission for process metrics. It is not granted by read or write. */
export type Permission = 'read:cases' | 'write:cases' | 'observe:metrics';
export interface VerifiedPrincipal { issuer: string; subject: string; scopes: ReadonlySet<string> }
export type VerifyToken = (authorization: string | undefined) => Promise<VerifiedPrincipal>;

/**
 * Principals produced by the verifier below. Only this module adds to the set, so a principal object built anywhere else
 * (a literal, a copy, a spread) is not authenticated. The set is private; code outside this module can only ask whether a
 * value was produced here.
 */
const authenticated = new WeakSet<VerifiedPrincipal>();

export function isAuthenticatedPrincipal(value: unknown): value is VerifiedPrincipal {
  return typeof value === 'object' && value !== null && authenticated.has(value as VerifiedPrincipal);
}

function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code <= 0x1f || code === 0x7f;
  });
}

/** Key injection exists only in code-driven tests; configuration never enables a bypass. */
export function createTokenVerifier(config: Pick<AuthConfig, 'issuer' | 'audience'> & { jwksUri?: string },
  testKeyResolver?: JWTVerifyGetKey, fetchImpl?: typeof fetch): VerifyToken {
  validateIssuer(config.issuer);
  if (config.jwksUri !== undefined) validateJwksUri(config.jwksUri);
  if (testKeyResolver && process.env.NODE_ENV !== 'test') throw new Error('Test key resolver is unavailable.');
  const keys = testKeyResolver ?? keysFromProvider(config, fetchImpl);
  return async (authorization) => {
    try {
      if (!authorization || authorization.length > 8192 || !/^Bearer [A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/i.test(authorization)) {
        throw new AuthorizationError(401);
      }
      const { payload } = await jwtVerify(authorization.slice(7), keys, {
        algorithms: ['RS256'], issuer: config.issuer, audience: config.audience,
        requiredClaims: ['iss', 'aud', 'sub', 'exp'], clockTolerance: 0,
      });
      if (typeof payload.sub !== 'string' || payload.sub.length === 0 || payload.sub.length > 255
        || hasControlCharacter(payload.sub)) throw new AuthorizationError(401);
      if (payload.scope !== undefined && (typeof payload.scope !== 'string' || payload.scope.length > 4096
        || !/^[A-Za-z0-9:_-]+(?: [A-Za-z0-9:_-]+)*$/.test(payload.scope))) throw new AuthorizationError(401);
      const principal: VerifiedPrincipal = Object.freeze({
        issuer: config.issuer, subject: payload.sub, scopes: new Set((payload.scope as string | undefined)?.split(' ') ?? []),
      });
      authenticated.add(principal);
      identityOutcomes.add(1, { 'aegis.identity.outcome': 'verified' });
      return principal;
    } catch {
      // Signature, claim and JWKS failures deliberately share one public error.
      identityOutcomes.add(1, { 'aegis.identity.outcome': 'refused' });
      logEvent('identity.refused', { outcome: 'refused' });
      throw new AuthorizationError(401);
    }
  };
}

export function requireScope(principal: VerifiedPrincipal, permission: Permission): void {
  if (!principal.scopes.has(permission)) throw new AuthorizationError(403);
}

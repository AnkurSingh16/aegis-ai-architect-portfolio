import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';
import type { AuthConfig } from './config.js';
import { validateIssuer } from './config.js';

export class AuthorizationError extends Error {
  constructor(public readonly status: 401 | 403) {
    super(status === 401 ? 'Authentication required.' : 'Access denied.');
  }
}
export type Permission = 'read:cases' | 'write:cases';
export interface VerifiedPrincipal { issuer: string; subject: string; scopes: ReadonlySet<string> }
export type VerifyToken = (authorization: string | undefined) => Promise<VerifiedPrincipal>;

function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code <= 0x1f || code === 0x7f;
  });
}

/** Key injection exists only in code-driven tests; configuration never enables a bypass. */
export function createTokenVerifier(config: Pick<AuthConfig, 'issuer' | 'audience'>,
  testKeyResolver?: JWTVerifyGetKey): VerifyToken {
  validateIssuer(config.issuer);
  if (testKeyResolver && process.env.NODE_ENV !== 'test') throw new Error('Test key resolver is unavailable.');
  const keys = testKeyResolver ?? createRemoteJWKSet(new URL('.well-known/jwks.json', config.issuer), {
    timeoutDuration: 5000, cooldownDuration: 30000, cacheMaxAge: 600000,
  });
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
      return { issuer: config.issuer, subject: payload.sub, scopes: new Set((payload.scope as string | undefined)?.split(' ') ?? []) };
    } catch {
      // Signature, claim and JWKS failures deliberately share one public error.
      throw new AuthorizationError(401);
    }
  };
}

export function requireScope(principal: VerifiedPrincipal, permission: Permission): void {
  if (!principal.scopes.has(permission)) throw new AuthorizationError(403);
}

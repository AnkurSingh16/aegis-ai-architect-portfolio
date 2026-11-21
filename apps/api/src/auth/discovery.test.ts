import { describe, expect, it } from 'vitest';
import { discoverJwksUri, keysFromProvider } from './token.js';

// Discovery and key resolution with a stubbed transport. The real provider path is exercised against Keycloak in the integration suite.
const ISSUER = 'https://issuer.example/realms/aegis';
const JWKS = 'https://issuer.example/realms/aegis/protocol/openid-connect/certs';

function fetchReturning(body: unknown, init: { status?: number } = {}): typeof fetch {
  return (async () => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status: init.status ?? 200 })) as typeof fetch;
}

describe('OpenID Connect discovery', () => {
  it('returns the jwks_uri of a document whose issuer matches exactly', async () => {
    expect(await discoverJwksUri(ISSUER, fetchReturning({ issuer: ISSUER, jwks_uri: JWKS }))).toBe(JWKS);
  });

  it('refuses a document whose issuer differs, even by a trailing slash', async () => {
    await expect(discoverJwksUri(ISSUER, fetchReturning({ issuer: `${ISSUER}/`, jwks_uri: JWKS }))).rejects.toThrow('Identity discovery failed.');
  });

  it('refuses an unsafe jwks_uri in the document', async () => {
    await expect(discoverJwksUri(ISSUER, fetchReturning({ issuer: ISSUER, jwks_uri: 'http://attacker.example/keys' })))
      .rejects.toThrow('Invalid authentication configuration.');
  });

  it('refuses an error status, a missing jwks_uri and an oversized body', async () => {
    await expect(discoverJwksUri(ISSUER, fetchReturning({ issuer: ISSUER }, { status: 500 }))).rejects.toThrow('Identity discovery failed.');
    await expect(discoverJwksUri(ISSUER, fetchReturning({ issuer: ISSUER }))).rejects.toThrow('Identity discovery failed.');
    await expect(discoverJwksUri(ISSUER, fetchReturning('x'.repeat(70000)))).rejects.toThrow('Identity discovery failed.');
  });

  it('requests the discovery document under the issuer, without following redirects', async () => {
    const seen: { url: string; redirect?: RequestInit['redirect'] }[] = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      seen.push({ url: String(url), redirect: init?.redirect });
      return new Response(JSON.stringify({ issuer: ISSUER, jwks_uri: JWKS }), { status: 200 });
    }) as typeof fetch;
    await discoverJwksUri(ISSUER, fetchImpl);
    expect(seen).toEqual([{ url: `${ISSUER}/.well-known/openid-configuration`, redirect: 'error' }]);
  });
});

describe('key resolution', () => {
  it('uses an explicit JWKS URL without contacting discovery', async () => {
    let contacted = false;
    const fetchImpl = (async () => { contacted = true; return new Response('{}', { status: 500 }); }) as typeof fetch;
    const resolver = keysFromProvider({ issuer: ISSUER, jwksUri: JWKS }, fetchImpl);
    expect(typeof resolver).toBe('function');
    expect(contacted).toBe(false);
  });

  it('retries discovery after a failure instead of caching the failure', async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return calls === 1 ? new Response('{}', { status: 503 }) : new Response(JSON.stringify({ issuer: ISSUER, jwks_uri: JWKS }), { status: 200 });
    }) as typeof fetch;
    const resolver = keysFromProvider({ issuer: ISSUER }, fetchImpl);
    await expect(resolver({ alg: 'RS256' } as never, 'a.b.c' as never)).rejects.toThrow();
    // The second call resolves discovery again, so it reaches the JWKS fetch and does not reuse the failure.
    await expect(resolver({ alg: 'RS256' } as never, 'a.b.c' as never)).rejects.not.toThrow('Identity discovery failed.');
    expect(calls).toBe(2);
  });
});

import { describe, expect, it } from 'vitest';
import { generateKeyPair, SignJWT } from 'jose';
import { AuthorizationError, createTokenVerifier, isAuthenticatedPrincipal } from './token.js';
import { createTestAuthentication, TEST_AUDIENCE, TEST_ISSUER } from './test-authentication.js';

const auth = await createTestAuthentication();
const other = await generateKeyPair('RS256');

async function expect401(promise: Promise<unknown>) {
  await expect(promise).rejects.toMatchObject({ status: 401 });
  await expect(promise).rejects.toBeInstanceOf(AuthorizationError);
}

describe('forged identities are refused at the authentication layer', () => {
  it('accepts a genuine token and marks its principal as authenticated', async () => {
    const principal = await auth.principal('user-7', ['read:cases']);
    expect(isAuthenticatedPrincipal(principal)).toBe(true);
    expect(principal.subject).toBe('user-7');
    expect([...principal.scopes]).toEqual(['read:cases']);
  });

  it('refuses a token signed by a key the verifier does not trust', async () => {
    const forged = await new SignJWT({ scope: 'read:cases write:cases' }).setProtectedHeader({ alg: 'RS256' })
      .setIssuer(TEST_ISSUER).setAudience(TEST_AUDIENCE).setSubject('admin').setExpirationTime('5m').sign(other.privateKey);
    await expect401(auth.verify(`Bearer ${forged}`));
  });

  it('refuses a genuine token whose scope claim was edited after signing', async () => {
    const genuine = await auth.sign('user-7', ['read:cases']);
    const [header, , signature] = genuine.split('.');
    const escalated = Buffer.from(JSON.stringify({ iss: TEST_ISSUER, aud: TEST_AUDIENCE, sub: 'user-7', scope: 'read:cases write:cases', exp: Math.floor(Date.now() / 1000) + 300, iat: Math.floor(Date.now() / 1000) }))
      .toString('base64url');
    await expect401(auth.verify(`Bearer ${header}.${escalated}.${signature}`));
  });

  it('refuses a token from another issuer, for another audience, or already expired', async () => {
    await expect401(auth.verify(`Bearer ${await auth.sign('user-7', ['read:cases'], { issuer: 'https://evil.example.test/' })}`));
    await expect401(auth.verify(`Bearer ${await auth.sign('user-7', ['read:cases'], { audience: 'another-api' })}`));
    await expect401(auth.verify(`Bearer ${await auth.sign('user-7', ['read:cases'], { expiresIn: '-1m' })}`));
  });

  it('refuses a token without a subject, and malformed or hostile scope claims', async () => {
    const noSubject = await new SignJWT({ scope: 'read:cases' }).setProtectedHeader({ alg: 'RS256' })
      .setIssuer(TEST_ISSUER).setAudience(TEST_AUDIENCE).setExpirationTime('5m').sign(auth.privateKey);
    await expect401(auth.verify(`Bearer ${noSubject}`));
    await expect401(auth.verify(`Bearer ${await new SignJWT({ scope: 'read:cases\u0007' }).setProtectedHeader({ alg: 'RS256' })
      .setIssuer(TEST_ISSUER).setAudience(TEST_AUDIENCE).setSubject('user-7').setExpirationTime('5m').sign(auth.privateKey)}`));
  });

  it('refuses requests without a bearer token, and malformed authorization headers', async () => {
    await expect401(auth.verify(undefined));
    await expect401(auth.verify('Basic dXNlcjpwYXNz'));
    await expect401(auth.verify('Bearer not-a-jwt'));
  });

  it('does not treat a principal-shaped literal as authenticated', () => {
    const literal = { issuer: TEST_ISSUER, subject: 'admin', scopes: new Set(['read:cases', 'write:cases']) };
    expect(isAuthenticatedPrincipal(literal)).toBe(false);
    expect(isAuthenticatedPrincipal({ ...literal })).toBe(false);
  });

  it('refuses a test key resolver outside the test environment', async () => {
    const original = process.env.NODE_ENV;
    try {
      process.env.NODE_ENV = 'production';
      expect(() => createTokenVerifier({ issuer: TEST_ISSUER, audience: TEST_AUDIENCE }, async () => other.publicKey))
        .toThrow('Test key resolver is unavailable.');
    } finally {
      process.env.NODE_ENV = original;
    }
  });
});

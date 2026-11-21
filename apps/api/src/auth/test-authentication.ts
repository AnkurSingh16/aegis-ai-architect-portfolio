import { generateKeyPair, SignJWT } from 'jose';
import { createTokenVerifier, type VerifiedPrincipal, type VerifyToken } from './token.js';

/**
 * Test-only authentication. It signs real RS256 tokens and verifies them with the production verifier (createTokenVerifier),
 * so every principal it returns was produced by the authentication layer. Its test key resolver is refused outside NODE_ENV=test.
 * Nothing in production code imports this module.
 */
export const TEST_ISSUER = 'https://issuer.example.test/';
export const TEST_AUDIENCE = 'aegis-test';

export async function createTestAuthentication() {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const verify: VerifyToken = createTokenVerifier({ issuer: TEST_ISSUER, audience: TEST_AUDIENCE }, async () => publicKey);

  interface SignOptions { readonly key?: Parameters<SignJWT['sign']>[0]; readonly issuer?: string; readonly audience?: string; readonly expiresIn?: string }

  async function sign(subject: string, scopes: readonly string[], options: SignOptions = {}): Promise<string> {
    // A token with no scopes carries no scope claim, as an identity provider issues it. An empty string is rejected by the verifier.
    const claims: Record<string, string> = scopes.length > 0 ? { scope: scopes.join(' ') } : {};
    return new SignJWT(claims)
      .setProtectedHeader({ alg: 'RS256' })
      .setIssuer(options.issuer ?? TEST_ISSUER)
      .setAudience(options.audience ?? TEST_AUDIENCE)
      .setSubject(subject)
      .setIssuedAt()
      .setExpirationTime(options.expiresIn ?? '5m')
      .sign(options.key ?? privateKey);
  }

  /** A genuine principal: signed, then verified through the production verifier. */
  async function principal(subject: string, scopes: readonly string[]): Promise<VerifiedPrincipal> {
    return verify(`Bearer ${await sign(subject, scopes)}`);
  }

  return { verify, sign, principal, privateKey };
}

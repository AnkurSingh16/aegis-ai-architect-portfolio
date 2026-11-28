import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ASSERTION_VERSION, AssertionRefusal, LIMITS, encodePayload, signAssertion, verifyAssertion, type AssertionFields } from './db-authority-assertion.js';

/** The internal refusal code, for tests only. Callers receive the generic message. */
const codeOf = (fn: () => unknown): string => {
  try { fn(); } catch (error) { return (error as AssertionRefusal).code; }
  return 'no refusal';
};

// SYNTHETIC key of the required length. It is a fixed test value and not a deployment secret.
const KEY = Buffer.alloc(32, 0x42);
const base: AssertionFields = {
  keyId: 'ci-test-1', issuer: 'https://synthetic.example/', subject: 'synthetic|reader-1', tenantId: '10000000-0000-4000-8000-000000000001',
  scopeCeiling: ['read:cases'], purpose: 'case_read', audience: 'aegis-ci-database', runtimeLogin: 'aegis_app',
  transactionId: '1234567890123456789', backendPid: 4242, issuedAt: 1_800_000_000, expiresAt: 1_800_000_060,
  assertionId: '6f9d2c1e-3b4a-4c5d-8e9f-0a1b2c3d4e5f',
};

/*
 * INDEPENDENT KNOWN-ANSWER FIXTURE. The payload and MAC below were produced by a separate Python implementation (hashlib, hmac), not by this
 * module: the payload is the length-prefixed UTF-8 of the 14 fields in order, and the MAC is HMAC-SHA-256 with key = 32 bytes of 0x42 over
 * exactly those payload bytes. The PostgreSQL verifier (migration 027) must reproduce these literals. Any change here is a protocol change.
 */
const KAT_PAYLOAD_HEX = '31333a61656769732d617574682d7631393a63692d746573742d3132363a68747470733a2f2f73796e7468657469632e6578616d706c652f31383a73796e7468657469637c7265616465722d3133363a31303030303030302d303030302d343030302d383030302d30303030303030303030303131303a726561643a6361736573393a636173655f7265616431373a61656769732d63692d6461746162617365393a61656769735f61707031393a31323334353637383930313233343536373839343a3432343231303a3138303030303030303031303a3138303030303030363033363a36663964326331652d336234612d346335642d386539662d306131623263336434653566';
const KAT_MAC_HEX = 'de36d8c9da9c82e02539016b56963360a192e47327ad0b30d4f4af6731041e8c';

describe('aegis-auth-v1 known-answer interoperability (independent fixture, literal values)', () => {
  it('the payload is 264 bytes and matches the independent literal, byte for byte', () => {
    const payload = encodePayload(['aegis-auth-v1', 'ci-test-1', 'https://synthetic.example/', 'synthetic|reader-1',
      '10000000-0000-4000-8000-000000000001', 'read:cases', 'case_read', 'aegis-ci-database', 'aegis_app', '1234567890123456789', '4242',
      '1800000000', '1800000060', '6f9d2c1e-3b4a-4c5d-8e9f-0a1b2c3d4e5f']);
    expect(payload.length).toBe(264);
    expect(payload.toString('hex')).toBe(KAT_PAYLOAD_HEX);
  });

  it('the MAC over the literal payload equals the independent literal MAC', () => {
    const mac = createHmac('sha256', KEY).update(Buffer.from(KAT_PAYLOAD_HEX, 'hex')).digest('hex');
    expect(mac).toBe(KAT_MAC_HEX);
  });

  it('the signer produces exactly the literal token, and the verifier accepts the literal token', () => {
    const token = signAssertion(base, KEY);
    expect(token).toBe(`${ASSERTION_VERSION}.${KAT_PAYLOAD_HEX}.${KAT_MAC_HEX}`);
    expect(verifyAssertion(`${ASSERTION_VERSION}.${KAT_PAYLOAD_HEX}.${KAT_MAC_HEX}`, KEY)).toEqual(base);
  });
});

describe('cross-language encoding rules', () => {
  it('counts UTF-8 bytes, not code units, in length prefixes', () => {
    expect(encodePayload(['é']).toString('utf8')).toBe('2:é');
    expect(encodePayload(['😀']).toString('utf8')).toBe('4:😀');
  });

  it('refuses NUL, other control characters, and unpaired surrogates in any field', () => {
    expect(codeOf(() => encodePayload(['a\u0000b']))).not.toBe('no refusal');
    expect(codeOf(() => encodePayload(['a\u0007b']))).not.toBe('no refusal');
    expect(codeOf(() => encodePayload(['\uD800']))).not.toBe('no refusal');
    expect(codeOf(() => encodePayload(['\uDC00x']))).not.toBe('no refusal');
    expect(codeOf(() => signAssertion({ ...base, subject: 'x\u0000' }, KEY))).not.toBe('no refusal');
    expect(codeOf(() => signAssertion({ ...base, issuer: '\uD83D' }, KEY))).not.toBe('no refusal');
  });

  it('refuses a payload whose UTF-8 is invalid, even when its MAC is valid', () => {
    // A field of one invalid UTF-8 byte (0xff), correctly length-prefixed and signed with the real key.
    const payload = Buffer.concat([Buffer.from('1:'), Buffer.from([0xff])]);
    const mac = createHmac('sha256', KEY).update(payload).digest('hex');
    expect(codeOf(() => verifyAssertion(`${ASSERTION_VERSION}.${payload.toString('hex')}.${mac}`, KEY))).not.toBe('no refusal');
  });

  it('refuses leading zeros in length prefixes, even when the MAC is valid', () => {
    const payload = Buffer.from('02:ab', 'ascii');
    const mac = createHmac('sha256', KEY).update(payload).digest('hex');
    expect(codeOf(() => verifyAssertion(`${ASSERTION_VERSION}.${payload.toString('hex')}.${mac}`, KEY))).not.toBe('no refusal');
  });

  it('refuses duplicated scopes instead of silently deduplicating them', () => {
    expect(codeOf(() => signAssertion({ ...base, scopeCeiling: ['read:cases', 'read:cases'] }, KEY))).toBe('duplicate_scope');
  });
});

describe('numeric and time bounds', () => {
  it('accepts a canonical xid8 at both ends of its range and refuses out-of-range or non-canonical forms', () => {
    expect(signAssertion({ ...base, transactionId: '18446744073709551615' }, KEY)).toBeTruthy();
    expect(codeOf(() => signAssertion({ ...base, transactionId: '18446744073709551616' }, KEY))).toBe('invalid_transaction');
    expect(codeOf(() => signAssertion({ ...base, transactionId: '0' }, KEY))).toBe('invalid_transaction');
    expect(codeOf(() => signAssertion({ ...base, transactionId: '01234' }, KEY))).toBe('invalid_transaction');
    expect(codeOf(() => signAssertion({ ...base, transactionId: '1e5' }, KEY))).toBe('invalid_transaction');
    expect(codeOf(() => signAssertion({ ...base, transactionId: '-1' }, KEY))).toBe('invalid_transaction');
    expect(codeOf(() => signAssertion({ ...base, transactionId: '123456789012345678901' }, KEY))).toBe('invalid_transaction');
  });

  it('refuses unsafe or negative timestamps and lifetimes above the maximum', () => {
    expect(codeOf(() => signAssertion({ ...base, issuedAt: Number.MAX_SAFE_INTEGER + 1, expiresAt: Number.MAX_SAFE_INTEGER + 2 }, KEY))).toBe('invalid_time');
    expect(codeOf(() => signAssertion({ ...base, issuedAt: -1, expiresAt: 10 }, KEY))).toBe('invalid_time');
    expect(codeOf(() => signAssertion({ ...base, expiresAt: base.issuedAt + LIMITS.maxLifetimeSeconds + 1 }, KEY))).toBe('lifetime');
    expect(codeOf(() => signAssertion({ ...base, expiresAt: base.issuedAt }, KEY))).toBe('lifetime');
  });
});

describe('limits and keys are shared and enforced on both sides', () => {
  it('refuses keys shorter than the minimum on signing and on verification', () => {
    const short = Buffer.alloc(LIMITS.minKeyBytes - 1, 1);
    expect(codeOf(() => signAssertion(base, short))).toBe('invalid_key');
    expect(codeOf(() => verifyAssertion(`${ASSERTION_VERSION}.${KAT_PAYLOAD_HEX}.${KAT_MAC_HEX}`, short))).toBe('invalid_key');
  });

  it('refuses a MAC that is not exactly 32 bytes', () => {
    expect(codeOf(() => verifyAssertion(`${ASSERTION_VERSION}.${KAT_PAYLOAD_HEX}.${KAT_MAC_HEX.slice(0, 62)}`, KEY))).toBe('malformed');
    expect(codeOf(() => verifyAssertion(`${ASSERTION_VERSION}.${KAT_PAYLOAD_HEX}.${KAT_MAC_HEX}00`, KEY))).toBe('malformed');
  });

  it('refuses a token above the maximum length and a payload above the maximum size before parsing', () => {
    expect(codeOf(() => verifyAssertion('a'.repeat(LIMITS.maxTokenChars + 1), KEY))).toBe('oversized');
    expect(['oversized', 'malformed']).toContain(codeOf(() => verifyAssertion(`${ASSERTION_VERSION}.${'00'.repeat(LIMITS.maxPayloadBytes + 1)}.${KAT_MAC_HEX}`, KEY)));
  });
});

describe('refusals are generic and reveal no key or payload', () => {
  it('every refusal has the same public message', () => {
    const messages = new Set<string>();
    const attempts: Array<() => unknown> = [
      () => verifyAssertion(undefined, KEY),
      () => verifyAssertion(`${ASSERTION_VERSION}.${KAT_PAYLOAD_HEX}.${'00'.repeat(32)}`, KEY),
      () => verifyAssertion(`aegis-auth-v9.${KAT_PAYLOAD_HEX}.${KAT_MAC_HEX}`, KEY),
      () => signAssertion({ ...base, purpose: 'nope' as never }, KEY),
    ];
    for (const attempt of attempts) {
      try { attempt(); } catch (error) { messages.add((error as Error).message); }
    }
    expect([...messages]).toEqual(['authority assertion refused']);
  });
});

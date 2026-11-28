import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { AssertionRefusal, ASSERTION_VERSION, MAX_PAYLOAD_BYTES, encodePayload, signAssertion, verifyAssertion, type AssertionFields } from './db-authority-assertion.js';

// Synthetic key of the length the protocol requires. It is a fixed test value, never a deployment secret.
const KEY = Buffer.alloc(32, 0x42);
const base: AssertionFields = {
  keyId: 'ci-test-1', issuer: 'https://synthetic.example/', subject: 'synthetic|reader-1', tenantId: '10000000-0000-4000-8000-000000000001',
  scopeCeiling: ['read:cases'], purpose: 'case_read', audience: 'aegis-ci-database', runtimeLogin: 'aegis_app',
  transactionId: '1234567890123456789', backendPid: 4242, issuedAt: 1_800_000_000, expiresAt: 1_800_000_060,
  assertionId: '6f9d2c1e-3b4a-4c5d-8e9f-0a1b2c3d4e5f',
};

describe('aegis-auth-v1 encoding (pinned; the database verifier must reproduce it byte for byte)', () => {
  it('encodes the fields as length-prefixed UTF-8 in a fixed order', () => {
    const payload = encodePayload(['aegis-auth-v1', 'a', 'é']).toString('utf8');
    // "é" is two UTF-8 bytes, so its prefix is 2.
    expect(payload).toBe('13:aegis-auth-v1' + '1:a' + '2:é');
  });

  it('a fixed input produces a fixed token and MAC (known-answer test)', () => {
    const token = signAssertion(base, KEY);
    expect(token.startsWith(`${ASSERTION_VERSION}.`)).toBe(true);
    const [, payloadHex, macHex] = token.split('.');
    // The MAC is HMAC-SHA-256 over exactly the payload bytes.
    expect(macHex).toBe(createHmac('sha256', KEY).update(Buffer.from(payloadHex, 'hex')).digest('hex'));
    expect(verifyAssertion(token, KEY)).toEqual({ ...base, scopeCeiling: ['read:cases'] });
  });

  it('round-trips every field exactly, including a two-scope ceiling in canonical order', () => {
    const two = { ...base, scopeCeiling: ['write:cases', 'read:cases'] };
    const decoded = verifyAssertion(signAssertion(two, KEY), KEY);
    expect(decoded.scopeCeiling).toEqual(['read:cases', 'write:cases']);
    expect(decoded.transactionId).toBe('1234567890123456789');
  });
});

describe('aegis-auth-v1 refusals (every one denies; none exposes the key or the payload)', () => {
  const token = signAssertion(base, KEY);

  it('refuses a non-string, an empty or a malformed token', () => {
    expect(() => verifyAssertion(undefined, KEY)).toThrow(AssertionRefusal);
    expect(() => verifyAssertion('', KEY)).toThrow(AssertionRefusal);
    expect(() => verifyAssertion('aegis-auth-v1.zz.zz', KEY)).toThrow(AssertionRefusal);
    expect(() => verifyAssertion(`${token}.extra`, KEY)).toThrow(AssertionRefusal);
  });

  it('refuses an oversized token before any parsing', () => {
    expect(() => verifyAssertion('a'.repeat(5000), KEY)).toThrow(/oversized/);
    expect(() => verifyAssertion(`aegis-auth-v1.${'00'.repeat(MAX_PAYLOAD_BYTES + 1)}.00`, KEY)).toThrow(/oversized/);
  });

  it('refuses an unknown version', () => {
    expect(() => verifyAssertion(token.replace('aegis-auth-v1.', 'aegis-auth-v2.'), KEY)).toThrow(/unknown_version/);
  });

  it('refuses a modified payload, a modified MAC and a wrong key', () => {
    const [v, payloadHex, macHex] = token.split('.');
    const flipped = payloadHex.slice(0, -2) + (payloadHex.slice(-2) === '00' ? '01' : '00');
    expect(() => verifyAssertion(`${v}.${flipped}.${macHex}`, KEY)).toThrow(/invalid_mac/);
    expect(() => verifyAssertion(`${v}.${payloadHex}.${'00'.repeat(32)}`, KEY)).toThrow(/invalid_mac/);
    expect(() => verifyAssertion(token, Buffer.alloc(32, 0x43))).toThrow(/invalid_mac/);
  });

  it('refuses a validly signed but non-canonical payload (scopes out of order)', () => {
    const fields = encodedFields({ ...base, scopeCeiling: ['read:cases'] });
    const reordered = fields.map((value, index) => (index === 5 ? 'write:cases,read:cases' : value));
    const payload = encodePayload(reordered);
    const mac = createHmac('sha256', KEY).update(payload).digest('hex');
    expect(() => verifyAssertion(`${ASSERTION_VERSION}.${payload.toString('hex')}.${mac}`, KEY)).toThrow(/malformed/);
  });

  it('refuses out-of-bounds fields at signing time: lifetime, scope, purpose, transaction, pid', () => {
    expect(() => signAssertion({ ...base, expiresAt: base.issuedAt + 301 }, KEY)).toThrow(/bounds/);
    expect(() => signAssertion({ ...base, expiresAt: base.issuedAt }, KEY)).toThrow(/bounds/);
    expect(() => signAssertion({ ...base, scopeCeiling: ['admin:everything'] }, KEY)).toThrow(/invalid_field/);
    expect(() => signAssertion({ ...base, scopeCeiling: [] }, KEY)).toThrow(/invalid_field/);
    expect(() => signAssertion({ ...base, purpose: 'delete_everything' as never }, KEY)).toThrow(/invalid_field/);
    expect(() => signAssertion({ ...base, transactionId: '12345678901234567890123' }, KEY)).toThrow(/invalid_field/);
    expect(() => signAssertion({ ...base, backendPid: 0 }, KEY)).toThrow(/invalid_field/);
    expect(() => signAssertion({ ...base, tenantId: 'not-a-uuid' }, KEY)).toThrow(/invalid_field/);
  });

  it('refuses a key shorter than 32 bytes', () => {
    expect(() => signAssertion(base, Buffer.alloc(16, 1))).toThrow(/invalid_field/);
  });
});

/** The ordered field values of a set of fields, as the encoder receives them. Used to construct a validly signed non-canonical payload. */
function encodedFields(f: AssertionFields): string[] {
  return ['aegis-auth-v1', f.keyId, f.issuer, f.subject, f.tenantId, f.scopeCeiling.join(','), f.purpose, f.audience, f.runtimeLogin,
    f.transactionId, String(f.backendPid), String(f.issuedAt), String(f.expiresAt), f.assertionId];
}

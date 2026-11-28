import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Transaction-bound database authority assertion, version `aegis-auth-v1` (Phase B1). Trusted application code signs it with HMAC-SHA-256.
 * PostgreSQL verifies the same MAC with pgcrypto and checks every binding independently (migration 027). The assertion is never trusted
 * because of its contents alone: an unsigned or mis-signed value is refused.
 *
 * Encoding (unambiguous, no JSON):
 *   payload = concatenation over the 14 ordered fields of  "<decimal byte length>:<utf-8 bytes>"
 *   token   = "aegis-auth-v1." + hex(payload) + "." + hex(HMAC-SHA-256(key, payload))
 * The MAC covers the exact payload bytes. Nothing is re-serialised before it is checked. The encoding is pinned by tests and must match
 * the verifier in migration 027 byte for byte.
 */

export const ASSERTION_VERSION = 'aegis-auth-v1';
export const MAX_TOKEN_CHARS = 4096;
export const MAX_PAYLOAD_BYTES = 2048;
export const MAX_FIELD_BYTES = 255;
export const MAX_LIFETIME_SECONDS = 300;
export const PURPOSES = ['case_read', 'case_write', 'investigation_create', 'investigation_read', 'investigation_cancel',
  'workflow_bookkeeping'] as const;
export type Purpose = (typeof PURPOSES)[number];
const SCOPES = ['read:cases', 'write:cases'] as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TXID = /^[0-9]{1,20}$/;
const HEX = /^(?:[0-9a-f]{2})+$/;

export interface AssertionFields {
  readonly keyId: string;
  readonly issuer: string;
  readonly subject: string;
  readonly tenantId: string;
  readonly scopeCeiling: readonly string[];
  readonly purpose: Purpose;
  readonly audience: string;
  readonly runtimeLogin: string;
  /** pg_current_xact_id() of the top-level transaction, as its decimal text. Never converted to a JavaScript number. */
  readonly transactionId: string;
  /** pg_backend_pid() of the connection, a positive 32-bit integer. */
  readonly backendPid: number;
  readonly issuedAt: number;
  readonly expiresAt: number;
  readonly assertionId: string;
}

export class AssertionRefusal extends Error {
  constructor(readonly code: 'malformed' | 'oversized' | 'unknown_version' | 'invalid_field' | 'invalid_mac' | 'bounds') {
    super(`authority assertion refused: ${code}`);
    this.name = 'AssertionRefusal';
  }
}

const FIELD_ORDER = ['version', 'keyId', 'issuer', 'subject', 'tenantId', 'scopeCeiling', 'purpose', 'audience', 'runtimeLogin',
  'transactionId', 'backendPid', 'issuedAt', 'expiresAt', 'assertionId'] as const;

function canonicalScopes(scopes: readonly string[]): string {
  if (scopes.length === 0 || scopes.length > SCOPES.length) throw new AssertionRefusal('invalid_field');
  for (const scope of scopes) if (!(SCOPES as readonly string[]).includes(scope)) throw new AssertionRefusal('invalid_field');
  return [...new Set(scopes)].sort().join(',');
}

function fieldValues(f: AssertionFields): string[] {
  return [ASSERTION_VERSION, f.keyId, f.issuer, f.subject, f.tenantId, canonicalScopes(f.scopeCeiling), f.purpose, f.audience,
    f.runtimeLogin, f.transactionId, String(f.backendPid), String(f.issuedAt), String(f.expiresAt), f.assertionId];
}

/** The exact payload bytes for a set of fields. Exposed for the tests that pin the encoding. */
export function encodePayload(values: readonly string[]): Buffer {
  const parts: Buffer[] = [];
  for (const value of values) {
    const bytes = Buffer.from(value, 'utf8');
    if (bytes.length > MAX_FIELD_BYTES) throw new AssertionRefusal('bounds');
    parts.push(Buffer.from(`${bytes.length}:`, 'ascii'), bytes);
  }
  const payload = Buffer.concat(parts);
  if (payload.length > MAX_PAYLOAD_BYTES) throw new AssertionRefusal('bounds');
  return payload;
}

function validate(f: AssertionFields): void {
  if (!/^[a-z0-9][a-z0-9_-]{0,62}$/.test(f.keyId)) throw new AssertionRefusal('invalid_field');
  if (!UUID.test(f.tenantId) || !UUID.test(f.assertionId)) throw new AssertionRefusal('invalid_field');
  if (!(PURPOSES as readonly string[]).includes(f.purpose)) throw new AssertionRefusal('invalid_field');
  if (!TXID.test(f.transactionId)) throw new AssertionRefusal('invalid_field');
  if (!Number.isInteger(f.backendPid) || f.backendPid < 1 || f.backendPid > 2147483647) throw new AssertionRefusal('invalid_field');
  if (!Number.isInteger(f.issuedAt) || !Number.isInteger(f.expiresAt) || f.expiresAt <= f.issuedAt
    || f.expiresAt - f.issuedAt > MAX_LIFETIME_SECONDS) throw new AssertionRefusal('bounds');
  for (const value of [f.issuer, f.subject, f.audience, f.runtimeLogin]) {
    if (value.length === 0 || Buffer.byteLength(value, 'utf8') > MAX_FIELD_BYTES) throw new AssertionRefusal('bounds');
  }
}

/** Signs the fields with the trusted key (at least 32 bytes). The key never leaves trusted application code. */
export function signAssertion(fields: AssertionFields, key: Buffer): string {
  if (key.length < 32) throw new AssertionRefusal('invalid_field');
  validate(fields);
  const payload = encodePayload(fieldValues(fields));
  const mac = createHmac('sha256', key).update(payload).digest();
  const token = `${ASSERTION_VERSION}.${payload.toString('hex')}.${mac.toString('hex')}`;
  if (token.length > MAX_TOKEN_CHARS) throw new AssertionRefusal('oversized');
  return token;
}

/**
 * Verifies the MAC and decodes the fields. Refuses malformed, oversized, unknown-version and mis-signed input. The MAC comparison uses
 * crypto.timingSafeEqual. Field-level bindings (audience, login, transaction, backend, time) are checked by the database, not here.
 */
export function verifyAssertion(token: unknown, key: Buffer): AssertionFields {
  if (typeof token !== 'string') throw new AssertionRefusal('malformed');
  if (token.length > MAX_TOKEN_CHARS) throw new AssertionRefusal('oversized');
  const pieces = token.split('.');
  if (pieces.length !== 3) throw new AssertionRefusal('malformed');
  const [version, payloadHex, macHex] = pieces;
  if (version === undefined) throw new AssertionRefusal('malformed');
  if (version !== ASSERTION_VERSION) throw new AssertionRefusal('unknown_version');
  if (!HEX.test(payloadHex ?? '') || !HEX.test(macHex ?? '')) throw new AssertionRefusal('malformed');
  if ((payloadHex ?? '').length / 2 > MAX_PAYLOAD_BYTES) throw new AssertionRefusal('oversized');
  const payload = Buffer.from(payloadHex as string, 'hex');
  const suppliedMac = Buffer.from(macHex as string, 'hex');
  const expectedMac = createHmac('sha256', key).update(payload).digest();
  if (suppliedMac.length !== expectedMac.length || !timingSafeEqual(suppliedMac, expectedMac)) throw new AssertionRefusal('invalid_mac');
  const values = decodePayload(payload);
  if (values.length !== FIELD_ORDER.length || values[0] !== ASSERTION_VERSION) throw new AssertionRefusal('malformed');
  const get = (name: (typeof FIELD_ORDER)[number]) => values[FIELD_ORDER.indexOf(name)];
  const fields: AssertionFields = {
    keyId: get('keyId'), issuer: get('issuer'), subject: get('subject'), tenantId: get('tenantId'),
    scopeCeiling: get('scopeCeiling').split(','), purpose: get('purpose') as Purpose, audience: get('audience'),
    runtimeLogin: get('runtimeLogin'), transactionId: get('transactionId'), backendPid: Number(get('backendPid')),
    issuedAt: Number(get('issuedAt')), expiresAt: Number(get('expiresAt')), assertionId: get('assertionId'),
  };
  validate(fields);
  // Re-encoding must reproduce the authenticated bytes exactly: rejects any non-canonical field (for example a scope list out of order).
  if (!encodePayload(fieldValues(fields)).equals(payload)) throw new AssertionRefusal('malformed');
  return fields;
}

/** Strict netstring-style decode of the authenticated payload. Any irregularity refuses the assertion. */
function decodePayload(payload: Buffer): string[] {
  const values: string[] = [];
  let at = 0;
  while (at < payload.length) {
    const colon = payload.indexOf(0x3a, at);
    if (colon === -1 || colon === at) throw new AssertionRefusal('malformed');
    const lengthText = payload.subarray(at, colon).toString('ascii');
    if (!/^(0|[1-9][0-9]{0,2})$/.test(lengthText)) throw new AssertionRefusal('malformed');
    const length = Number(lengthText);
    if (length > MAX_FIELD_BYTES || colon + 1 + length > payload.length) throw new AssertionRefusal('malformed');
    values.push(payload.subarray(colon + 1, colon + 1 + length).toString('utf8'));
    at = colon + 1 + length;
  }
  return values;
}

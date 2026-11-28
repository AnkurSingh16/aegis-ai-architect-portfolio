import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Transaction-bound database authority assertion, protocol `aegis-auth-v1` (Phase B1). Trusted application code signs it with HMAC-SHA-256.
 * PostgreSQL verifies the same MAC with pgcrypto and independently checks every binding (migration 027). An assertion never establishes
 * authority by its contents alone: unsigned or mis-signed input is refused.
 *
 * Encoding (unambiguous, no JSON):
 *   payload = concatenation over the 14 ordered fields of  "<decimal byte length>:<strict UTF-8 bytes>"
 *   token   = "aegis-auth-v1." + hex(payload) + "." + hex(HMAC-SHA-256(key, payload))     (MAC: exactly 32 bytes, 64 hex characters)
 * The MAC covers the exact payload bytes; nothing is re-serialised before it is checked. The database verifier must reproduce the same bytes
 * (pinned by the literal known-answer fixture in the tests and by the integration tests against PostgreSQL).
 *
 * Canonical rules shared with PostgreSQL: strict UTF-8 (no unpaired surrogates, no NUL), decimal length prefixes without leading zeros,
 * canonical decimal numeric fields, scopes sorted and unique, transaction identifiers as canonical xid8 decimal text (never a JavaScript number).
 */

export const ASSERTION_VERSION = 'aegis-auth-v1';
/** Limits shared with the PostgreSQL verifier. Changing any value is a protocol change. */
export const LIMITS = {
  maxTokenChars: 4096,
  maxPayloadBytes: 2048,
  maxFieldBytes: 255,
  macBytes: 32,
  minKeyBytes: 32,
  maxLifetimeSeconds: 300,
  fieldCount: 14,
} as const;
export const PURPOSES = ['case_read', 'case_write', 'investigation_create', 'investigation_read', 'investigation_cancel',
  'workflow_bookkeeping'] as const;
export type Purpose = (typeof PURPOSES)[number];
export const SCOPES = ['read:cases', 'write:cases'] as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** xid8 decimal text: no sign, no leading zero, at most 20 digits, and within the unsigned 64-bit range (checked with BigInt). */
const XID8 = /^[1-9][0-9]{0,19}$/;
const XID8_MAX = 18446744073709551615n;
const KEY_ID = /^[a-z0-9][a-z0-9_-]{0,62}$/;
const HEX = /^(?:[0-9a-f]{2})+$/;
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const MAX_TIMESTAMP = 253402300799; // 9999-12-31T23:59:59Z, far from any safe-integer edge.

/** The one refusal used for every rejection. The code is for tests and never reaches a caller as a message. */
export class AssertionRefusal extends Error {
  constructor(readonly code: string) {
    super('authority assertion refused');
    this.name = 'AssertionRefusal';
  }
}

export interface AssertionFields {
  readonly keyId: string;
  readonly issuer: string;
  readonly subject: string;
  readonly tenantId: string;
  readonly scopeCeiling: readonly string[];
  readonly purpose: Purpose;
  readonly audience: string;
  readonly runtimeLogin: string;
  /** pg_current_xact_id() of the top-level transaction, canonical decimal text. Never converted to a JavaScript number. */
  readonly transactionId: string;
  /** pg_backend_pid() of the connection, a positive 32-bit integer. */
  readonly backendPid: number;
  readonly issuedAt: number;
  readonly expiresAt: number;
  readonly assertionId: string;
}

const FIELD_ORDER = ['version', 'keyId', 'issuer', 'subject', 'tenantId', 'scopeCeiling', 'purpose', 'audience', 'runtimeLogin',
  'transactionId', 'backendPid', 'issuedAt', 'expiresAt', 'assertionId'] as const;

/** A text value is accepted only if it is well-formed Unicode without NUL or other control characters. Nothing is normalised. */
function assertText(value: string, maxBytes: number): void {
  if (LONE_SURROGATE.test(value)) throw new AssertionRefusal('invalid_unicode');
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0;
    if (code <= 0x1f || code === 0x7f) throw new AssertionRefusal('invalid_text');
  }
  if (value.length === 0 || Buffer.byteLength(value, 'utf8') > maxBytes) throw new AssertionRefusal('bounds');
}

function canonicalScopes(scopes: readonly string[]): string {
  if (scopes.length === 0 || scopes.length > SCOPES.length) throw new AssertionRefusal('invalid_scope');
  for (const scope of scopes) if (!(SCOPES as readonly string[]).includes(scope)) throw new AssertionRefusal('invalid_scope');
  if (new Set(scopes).size !== scopes.length) throw new AssertionRefusal('duplicate_scope');
  return [...scopes].sort().join(',');
}

function fieldValues(f: AssertionFields): string[] {
  return [ASSERTION_VERSION, f.keyId, f.issuer, f.subject, f.tenantId, canonicalScopes(f.scopeCeiling), f.purpose, f.audience,
    f.runtimeLogin, f.transactionId, String(f.backendPid), String(f.issuedAt), String(f.expiresAt), f.assertionId];
}

/** The exact payload bytes for a list of field values. Exposed so the tests pin the encoding. */
export function encodePayload(values: readonly string[]): Buffer {
  const parts: Buffer[] = [];
  for (const value of values) {
    assertText(value, LIMITS.maxFieldBytes);
    const bytes = Buffer.from(value, 'utf8');
    parts.push(Buffer.from(`${bytes.length}:`, 'ascii'), bytes);
  }
  const payload = Buffer.concat(parts);
  if (payload.length > LIMITS.maxPayloadBytes) throw new AssertionRefusal('bounds');
  return payload;
}

function validate(f: AssertionFields): void {
  if (!KEY_ID.test(f.keyId)) throw new AssertionRefusal('invalid_key_id');
  assertText(f.issuer, LIMITS.maxFieldBytes);
  assertText(f.subject, LIMITS.maxFieldBytes);
  assertText(f.audience, LIMITS.maxFieldBytes);
  assertText(f.runtimeLogin, LIMITS.maxFieldBytes);
  if (!UUID.test(f.tenantId) || !UUID.test(f.assertionId)) throw new AssertionRefusal('invalid_uuid');
  if (!(PURPOSES as readonly string[]).includes(f.purpose)) throw new AssertionRefusal('invalid_purpose');
  if (!XID8.test(f.transactionId) || BigInt(f.transactionId) > XID8_MAX) throw new AssertionRefusal('invalid_transaction');
  if (!Number.isSafeInteger(f.backendPid) || f.backendPid < 1 || f.backendPid > 2147483647) throw new AssertionRefusal('invalid_backend');
  if (!Number.isSafeInteger(f.issuedAt) || !Number.isSafeInteger(f.expiresAt)) throw new AssertionRefusal('invalid_time');
  if (f.issuedAt < 0 || f.expiresAt > MAX_TIMESTAMP) throw new AssertionRefusal('invalid_time');
  if (f.expiresAt <= f.issuedAt || f.expiresAt - f.issuedAt > LIMITS.maxLifetimeSeconds) throw new AssertionRefusal('lifetime');
}

function assertKey(key: Buffer): void {
  if (!Buffer.isBuffer(key) || key.length < LIMITS.minKeyBytes) throw new AssertionRefusal('invalid_key');
}

/** Signs the fields with the trusted key. The key never leaves trusted application code. */
export function signAssertion(fields: AssertionFields, key: Buffer): string {
  assertKey(key);
  validate(fields);
  const payload = encodePayload(fieldValues(fields));
  const mac = createHmac('sha256', key).update(payload).digest();
  const token = `${ASSERTION_VERSION}.${payload.toString('hex')}.${mac.toString('hex')}`;
  if (token.length > LIMITS.maxTokenChars) throw new AssertionRefusal('oversized');
  return token;
}

/**
 * Verifies the MAC and decodes the fields. Refuses malformed, oversized, unknown-version and mis-signed input. The MAC comparison uses
 * crypto.timingSafeEqual. Field bindings (audience, runtime login, transaction, backend, time) are checked by the database.
 */
export function verifyAssertion(token: unknown, key: Buffer): AssertionFields {
  assertKey(key);
  if (typeof token !== 'string') throw new AssertionRefusal('malformed');
  if (token.length > LIMITS.maxTokenChars) throw new AssertionRefusal('oversized');
  const pieces = token.split('.');
  if (pieces.length !== 3) throw new AssertionRefusal('malformed');
  const [version, payloadHex, macHex] = pieces;
  if (version !== ASSERTION_VERSION) throw new AssertionRefusal('unknown_version');
  if (!HEX.test(payloadHex) || payloadHex.length / 2 > LIMITS.maxPayloadBytes) throw new AssertionRefusal('malformed');
  if (macHex.length !== LIMITS.macBytes * 2 || !HEX.test(macHex)) throw new AssertionRefusal('malformed');
  const payload = Buffer.from(payloadHex, 'hex');
  const expectedMac = createHmac('sha256', key).update(payload).digest();
  if (!timingSafeEqual(Buffer.from(macHex, 'hex'), expectedMac)) throw new AssertionRefusal('invalid_mac');
  const values = decodePayload(payload);
  if (values.length !== LIMITS.fieldCount || values[0] !== ASSERTION_VERSION) throw new AssertionRefusal('malformed');
  const get = (name: (typeof FIELD_ORDER)[number]) => values[FIELD_ORDER.indexOf(name)];
  const fields: AssertionFields = {
    keyId: get('keyId'), issuer: get('issuer'), subject: get('subject'), tenantId: get('tenantId'),
    scopeCeiling: get('scopeCeiling').split(','), purpose: get('purpose') as Purpose, audience: get('audience'),
    runtimeLogin: get('runtimeLogin'), transactionId: get('transactionId'), backendPid: Number(get('backendPid')),
    issuedAt: Number(get('issuedAt')), expiresAt: Number(get('expiresAt')), assertionId: get('assertionId'),
  };
  validate(fields);
  // Re-encoding must reproduce the authenticated bytes exactly: rejects a validly signed payload that is not canonical.
  if (!encodePayload(fieldValues(fields)).equals(payload)) throw new AssertionRefusal('non_canonical');
  return fields;
}

/** Strict decode of the authenticated payload: canonical decimal prefixes, no leading zeros, strict UTF-8 (fatal on any invalid byte). */
function decodePayload(payload: Buffer): string[] {
  const values: string[] = [];
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  let at = 0;
  while (at < payload.length) {
    const colon = payload.indexOf(0x3a, at);
    if (colon === -1 || colon === at) throw new AssertionRefusal('malformed');
    const lengthText = payload.subarray(at, colon).toString('ascii');
    if (!/^(0|[1-9][0-9]{0,2})$/.test(lengthText)) throw new AssertionRefusal('malformed');
    const length = Number(lengthText);
    if (length > LIMITS.maxFieldBytes || colon + 1 + length > payload.length) throw new AssertionRefusal('malformed');
    let value: string;
    try { value = decoder.decode(payload.subarray(colon + 1, colon + 1 + length)); } catch { throw new AssertionRefusal('invalid_utf8'); }
    values.push(value);
    at = colon + 1 + length;
  }
  return values;
}

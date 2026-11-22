import { createHash } from 'node:crypto';
import { argumentsDigest, canonicalJson, checkEnvelopeStructure } from '../delegation.js';

/**
 * P5 wire format, version 1. This module is STRUCTURE ONLY: it proves a message is well formed, that its payload is the one the
 * sender digested, and that its envelope and wrapper agree. It proves nothing about authority. Authorisation is `receiveEnvelope`
 * in the P4 store, which checks the envelope against an open single-use grant, and nothing in a message can create that grant.
 */

export const MESSAGE_SCHEMA_VERSION = 1;
/** Limits are enforced twice: here, and by CHECK constraints in migration 017. */
export const MAX_ENVELOPE_BYTES = 4096;
export const MAX_PAYLOAD_BYTES = 8192;
export const MAX_BODY_BYTES = 16384;

export const WIRE_FIELDS = ['schemaVersion', 'messageId', 'tenantId', 'executionId', 'kind', 'envelope', 'payload', 'payloadDigest'] as const;

export type MessageKind = 'request' | 'result';

export interface WireMessage {
  readonly schemaVersion: typeof MESSAGE_SCHEMA_VERSION;
  readonly messageId: string;
  readonly tenantId: string;
  readonly executionId: string;
  readonly kind: MessageKind;
  readonly envelope: Record<string, unknown>;
  readonly payload: Record<string, unknown>;
  readonly payloadDigest: string;
}

export type WireRefusal = 'malformed' | 'unexpected_fields' | 'schema_version' | 'message_mismatch' | 'too_large'
  | 'payload_digest_mismatch' | 'arguments_digest_mismatch';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** Digest of the payload as the sender produced it. Canonical JSON, so key order cannot change the digest. */
export function payloadDigest(payload: Readonly<Record<string, unknown>>): string {
  return sha256(canonicalJson(payload));
}

/** Builds a version 1 wire message. The envelope is copied so later changes to the caller's object cannot alter it. */
export function buildWireMessage(input: {
  messageId: string; tenantId: string; executionId: string; kind: MessageKind;
  envelope: Record<string, unknown>; payload: Record<string, unknown>;
}): WireMessage {
  return {
    schemaVersion: MESSAGE_SCHEMA_VERSION,
    messageId: input.messageId,
    tenantId: input.tenantId,
    executionId: input.executionId,
    kind: input.kind,
    envelope: { ...input.envelope },
    payload: JSON.parse(canonicalJson(input.payload)) as Record<string, unknown>,
    payloadDigest: payloadDigest(input.payload),
  };
}

/** Validates the wire structure. Returns the message on success. Never reads a database and never trusts a field for authority. */
export function validateWireMessage(value: unknown, expectedMessageId?: string):
  { readonly ok: true; readonly message: WireMessage } | { readonly ok: false; readonly reason: WireRefusal } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return { ok: false, reason: 'malformed' };
  const candidate = value as Record<string, unknown>;
  const keys = Object.keys(candidate);
  if (keys.length !== WIRE_FIELDS.length || keys.some((key) => !(WIRE_FIELDS as readonly string[]).includes(key))) {
    return { ok: false, reason: 'unexpected_fields' };
  }
  if (candidate.schemaVersion !== MESSAGE_SCHEMA_VERSION) return { ok: false, reason: 'schema_version' };
  for (const field of ['messageId', 'tenantId', 'executionId'] as const) {
    if (typeof candidate[field] !== 'string' || !UUID.test(candidate[field] as string)) return { ok: false, reason: 'malformed' };
  }
  if (expectedMessageId !== undefined && candidate.messageId !== expectedMessageId) return { ok: false, reason: 'message_mismatch' };
  if (candidate.kind !== 'request' && candidate.kind !== 'result') return { ok: false, reason: 'malformed' };
  if (typeof candidate.payloadDigest !== 'string' || !/^[0-9a-f]{64}$/.test(candidate.payloadDigest)) return { ok: false, reason: 'malformed' };
  if (typeof candidate.envelope !== 'object' || candidate.envelope === null || Array.isArray(candidate.envelope)) return { ok: false, reason: 'malformed' };
  if (typeof candidate.payload !== 'object' || candidate.payload === null || Array.isArray(candidate.payload)) return { ok: false, reason: 'malformed' };
  if (canonicalJson(candidate.envelope).length > MAX_ENVELOPE_BYTES) return { ok: false, reason: 'too_large' };
  const payloadText = canonicalJson(candidate.payload);
  if (payloadText.length > MAX_PAYLOAD_BYTES) return { ok: false, reason: 'too_large' };

  const structure = checkEnvelopeStructure(candidate.envelope);
  if (!structure.ok) return { ok: false, reason: structure.reason === 'unexpected_fields' ? 'unexpected_fields' : 'malformed' };
  const envelope = structure.envelope;
  // The wrapper and the envelope must describe the same message. A mismatch is structural, not an authority question.
  if (envelope.kind !== candidate.kind || envelope.executionId !== candidate.executionId || envelope.tenantId !== candidate.tenantId) {
    return { ok: false, reason: 'message_mismatch' };
  }
  if (payloadDigest(candidate.payload as Record<string, unknown>) !== candidate.payloadDigest) return { ok: false, reason: 'payload_digest_mismatch' };
  // A request's arguments are what the grant authorised. The digest in the envelope must be the digest of the arguments in the payload.
  if (candidate.kind === 'request') {
    const args = (candidate.payload as Record<string, unknown>).arguments;
    if (typeof args !== 'object' || args === null || Array.isArray(args)) return { ok: false, reason: 'malformed' };
    if (argumentsDigest(args as Record<string, unknown>) !== envelope.argumentsDigest) return { ok: false, reason: 'arguments_digest_mismatch' };
  }
  return { ok: true, message: candidate as unknown as WireMessage };
}

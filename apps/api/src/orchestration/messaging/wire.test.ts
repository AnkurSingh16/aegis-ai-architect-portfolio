import { describe, expect, it } from 'vitest';
import { argumentsDigest } from '../delegation.js';
import { backoffSeconds, BACKOFF_CAP_SECONDS } from './backoff.js';
import { buildWireMessage, MAX_PAYLOAD_BYTES, payloadDigest, validateWireMessage } from './wire.js';
import { parseTriageArguments } from './handlers.js';
import { planFromQuestion } from '../../investigation/triage.js';

const MESSAGE = '11111111-1111-4111-8111-111111111111';
const TENANT = '22222222-2222-4222-8222-222222222222';
const EXECUTION = '33333333-3333-4333-8333-333333333333';
const args = { caseRef: '44444444-4444-4444-8444-444444444444', documentCount: 2, questionCode: 'status_check' as const };

function requestWire(overrides: { payload?: Record<string, unknown>; envelope?: Record<string, unknown> } = {}) {
  const payload = overrides.payload ?? { arguments: args };
  const envelope = { kind: 'request', executionId: EXECUTION, tenantId: TENANT, principalRef: 'a'.repeat(64), from: 'orchestrator',
    to: 'triage', depth: 1, chainDigest: 'b'.repeat(64), action: 'triage.classify', argumentsDigest: argumentsDigest(args),
    ...overrides.envelope };
  return JSON.parse(JSON.stringify(buildWireMessage({ messageId: MESSAGE, tenantId: TENANT, executionId: EXECUTION, kind: 'request',
    envelope, payload })));
}

describe('P5 wire structure (no authority)', () => {
  it('accepts a well-formed request and binds the payload by canonical digest', () => {
    const result = validateWireMessage(requestWire(), MESSAGE);
    expect(result.ok).toBe(true);
    const wire = requestWire();
    expect(wire.payloadDigest).toBe(payloadDigest(wire.payload));
  });

  it('refuses a payload altered after digesting', () => {
    const wire = requestWire();
    wire.payload.arguments.documentCount = 99;
    expect(validateWireMessage(wire, MESSAGE)).toEqual({ ok: false, reason: 'payload_digest_mismatch' });
  });

  it('refuses an argument digest that does not match the arguments in the payload', () => {
    const wire = requestWire({ envelope: { argumentsDigest: 'c'.repeat(64) } });
    wire.payloadDigest = payloadDigest(wire.payload);
    expect(validateWireMessage(wire, MESSAGE)).toEqual({ ok: false, reason: 'arguments_digest_mismatch' });
  });

  it('refuses a message whose wrapper and envelope disagree about the execution or tenant', () => {
    const wire = requestWire();
    wire.envelope.executionId = '55555555-5555-4555-8555-555555555555';
    expect(validateWireMessage(wire, MESSAGE)).toEqual({ ok: false, reason: 'message_mismatch' });
  });

  it('refuses unexpected fields, an unknown schema version, a foreign message id and oversized payloads', () => {
    expect(validateWireMessage({ ...requestWire(), authority: 'orchestrator' }, MESSAGE)).toEqual({ ok: false, reason: 'unexpected_fields' });
    expect(validateWireMessage({ ...requestWire(), schemaVersion: 2 }, MESSAGE)).toEqual({ ok: false, reason: 'schema_version' });
    expect(validateWireMessage(requestWire(), '66666666-6666-4666-8666-666666666666')).toEqual({ ok: false, reason: 'message_mismatch' });
    const big = { arguments: { ...args, note: 'x'.repeat(MAX_PAYLOAD_BYTES) } };
    const wire = requestWire({ payload: big });
    expect(validateWireMessage(wire, MESSAGE)).toEqual({ ok: false, reason: 'too_large' });
  });

  it('a message cannot carry its own authority: grant-like fields in the envelope are unexpected', () => {
    const wire = requestWire({ envelope: { grantId: 'd'.repeat(64) } });
    expect(validateWireMessage(wire, MESSAGE)).toEqual({ ok: false, reason: 'unexpected_fields' });
  });
});

describe('P5 backoff', () => {
  it('grows exponentially, is capped, and stays within jitter bounds', () => {
    expect(backoffSeconds(1, () => 0.5)).toBeCloseTo(1, 5);
    expect(backoffSeconds(3, () => 0.5)).toBeCloseTo(4, 5);
    expect(backoffSeconds(3, () => 0)).toBeCloseTo(3.2, 5);
    expect(backoffSeconds(30, () => 1)).toBe(BACKOFF_CAP_SECONDS);
    for (let i = 0; i < 50; i += 1) {
      const d = backoffSeconds(4, Math.random);
      expect(d).toBeGreaterThanOrEqual(8 * 0.8 - 1e-9);
      expect(d).toBeLessThanOrEqual(8 * 1.2 + 1e-9);
    }
  });

  it('refuses a non-positive attempt count', () => {
    expect(() => backoffSeconds(0)).toThrow(RangeError);
  });
});

describe('P5 triage effect (pure, read-only)', () => {
  it('depends only on the authorised arguments', () => {
    expect(planFromQuestion('Which policy document covers approvals?').retrieve).toBe(true);
    expect(planFromQuestion('What is the weather?').retrieve).toBe(false);
  });

  it('accepts only the exact argument shape', () => {
    expect(parseTriageArguments({ question: 'Which policy?' })).not.toBeNull();
    expect(parseTriageArguments({ question: 'Which policy?', extra: true })).toBeNull();
    expect(parseTriageArguments({ question: '' })).toBeNull();
    expect(parseTriageArguments('not an object')).toBeNull();
  });
});

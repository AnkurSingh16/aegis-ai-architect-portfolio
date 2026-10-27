import { describe, expect, it } from 'vitest';
import { isTriageResult, syntheticCases, TRIAGE_WARNING } from './contracts/triage.js';
import { triageCase } from './triage.js';

describe('deterministic synthetic triage', () => {
  it.each([
    ['SYNTHETIC-LOGIN-001', 'incident', 'high', 'Platform support'],
    ['SYNTHETIC-BILLING-002', 'billing', 'medium', 'Billing support'],
    ['SYNTHETIC-GUIDANCE-003', 'guidance', 'low', 'Customer support'],
  ] as const)('classifies %s repeatably', (caseId, category, priority, suggestedTeam) => {
    const result = triageCase(caseId);
    expect(result).toEqual(triageCase(caseId));
    expect(result).toMatchObject({ caseId, category, priority, suggestedTeam, mode: 'synthetic-mock', warning: TRIAGE_WARNING });
    expect(isTriageResult(result, caseId)).toBe(true);
  });

  it('returns independent results without mutating the fixture', () => {
    const result = triageCase(syntheticCases[0].id);
    result.rationale = 'changed';
    expect(triageCase(syntheticCases[0].id).rationale).not.toBe('changed');
  });

  it.each([null, undefined, [], 'text', 1, {}, { extra: true }])('rejects invalid response shape %j', (value) => {
    expect(isTriageResult(value, syntheticCases[0].id)).toBe(false);
  });

  it.each([
    ['mode', 'real-ai'], ['caseId', 'unknown'], ['category', 'other'], ['priority', 'critical'],
    ['suggestedTeam', 'Unknown team'], ['rationale', ''], ['rationale', '   '], ['rationale', 1],
    ['rationale', 'a'.repeat(501)], ['nextStep', null], ['nextStep', ''], ['nextStep', 'a'.repeat(501)],
    ['warning', 'Real AI'],
  ])('rejects invalid %s', (key, value) => {
    expect(isTriageResult({ ...triageCase(syntheticCases[0].id), [key]: value }, syntheticCases[0].id)).toBe(false);
  });

  it('rejects missing, extra and substituted keys as well as mismatched case identity', () => {
    const result = triageCase(syntheticCases[0].id);
    expect(isTriageResult({ ...result, extra: 'untrusted' }, result.caseId)).toBe(false);
    const { warning: _warning, ...missing } = result;
    expect(_warning).toBe(TRIAGE_WARNING);
    expect(isTriageResult(missing, result.caseId)).toBe(false);
    expect(isTriageResult({ ...missing, extra: true }, result.caseId)).toBe(false);
    expect(isTriageResult(result, syntheticCases[1].id)).toBe(false);
  });

  it('accepts bounded text at the maximum length', () => {
    const result = triageCase(syntheticCases[0].id);
    expect(isTriageResult({ ...result, rationale: 'a'.repeat(500), nextStep: 'b'.repeat(500) }, result.caseId)).toBe(true);
  });
});

import { describe, expect, it } from 'vitest';
import { guardAnswer } from './output-guard.js';

const policy = {
  forbiddenSubstrings: ['APPROVED-BY-SYSTEM'],
  allowedSourceIds: new Set(['policy-refunds', 'store-hours']),
};

describe('deterministic output guard', () => {
  it('accepts a grounded answer that cites an included source', () => {
    expect(guardAnswer('Refunds are accepted within 30 days [policy-refunds].', policy))
      .toEqual({ ok: true, violations: [], citedSourceIds: ['policy-refunds'] });
  });

  it('rejects a sentinel planted by untrusted evidence, case-insensitively', () => {
    const result = guardAnswer('approved-by-system', policy);
    expect(result.ok).toBe(false);
    expect(result.violations).toContain('forbidden_substring');
  });

  it('rejects citations to sources that were not in the assembled context', () => {
    const result = guardAnswer('Shipping takes five days [policy-shipping].', policy);
    expect(result.violations).toEqual(['unknown_citation']);
  });

  it('rejects empty answers', () => {
    expect(guardAnswer('   ', policy).violations).toEqual(['empty_answer']);
  });
});

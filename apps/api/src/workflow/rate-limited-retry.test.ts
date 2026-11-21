import { describe, expect, it } from 'vitest';
import { classifyFailure } from './retry-policy.js';

describe('a rate-limited triage step is retried, not failed permanently', () => {
  it('classifies the rate-limit error as retryable, and a generic denial as permanent', () => {
    const rateLimited = Object.assign(new Error('tool rate limited'), { name: 'RateLimitedError', retryable: true });
    expect(classifyFailure(rateLimited)).toBe('retryable');
    expect(classifyFailure(new Error('denied: missing_scope'))).toBe('permanent');
  });
});

import type { ExecutionEvent } from './execution-state.js';

export type FailureClass = 'retryable' | 'permanent';

export interface RetryPolicy {
  /** Total attempts including the first one. */
  readonly maxAttempts: number;
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
}

export class RetryPolicyError extends Error {
  readonly name = 'RetryPolicyError';
}

export function validateRetryPolicy(policy: RetryPolicy): RetryPolicy {
  const { maxAttempts, baseDelayMs, maxDelayMs } = policy;
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 10) {
    throw new RetryPolicyError('maxAttempts must be an integer from 1 to 10');
  }
  if (!Number.isInteger(baseDelayMs) || baseDelayMs < 0) throw new RetryPolicyError('baseDelayMs must be a non-negative integer');
  if (!Number.isInteger(maxDelayMs) || maxDelayMs < baseDelayMs) throw new RetryPolicyError('maxDelayMs must be an integer >= baseDelayMs');
  return policy;
}

/** Deterministic exponential backoff. attempt is the 1-based attempt that just failed. No jitter, so tests are exact. */
export function backoffDelayMs(attempt: number, policy: RetryPolicy): number {
  if (!Number.isInteger(attempt) || attempt < 1) throw new RetryPolicyError('attempt must be a positive integer');
  const exponent = Math.min(attempt - 1, 30);
  return Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** exponent);
}

const RETRYABLE_CODES = new Set(['ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'EAI_AGAIN', 'EPIPE']);

/** Fail closed: anything not positively identified as transient is permanent. */
export function classifyFailure(error: unknown): FailureClass {
  if (typeof error !== 'object' || error === null) return 'permanent';
  const candidate = error as { name?: unknown; code?: unknown; retryable?: unknown };
  if (candidate.retryable === true) return 'retryable';
  if (candidate.name === 'TimeoutError') return 'retryable';
  if (typeof candidate.code === 'string' && RETRYABLE_CODES.has(candidate.code)) return 'retryable';
  return 'permanent';
}

export interface FailureDecision {
  readonly event: Extract<ExecutionEvent, 'step_failed_retryable' | 'step_failed_permanent'>;
  readonly delayMs: number;
}

/** Retry only transient failures, and only while attempts remain. */
export function decideAfterFailure(failure: FailureClass, attempt: number, policy: RetryPolicy): FailureDecision {
  if (failure === 'permanent' || attempt >= policy.maxAttempts) {
    return { event: 'step_failed_permanent', delayMs: 0 };
  }
  return { event: 'step_failed_retryable', delayMs: backoffDelayMs(attempt, policy) };
}

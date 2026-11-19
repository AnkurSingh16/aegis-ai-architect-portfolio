import { type ExecutionState } from './execution-state.js';
import { classifyFailure, decideAfterFailure, type RetryPolicy, validateRetryPolicy } from './retry-policy.js';
import type { ExecutionRow } from './durable-store.js';
import { createDurableStore } from './durable-store.js';

export type DriverOutcome =
  | { readonly status: 'not_claimable' }
  | { readonly status: 'succeeded'; readonly attempt: number }
  | { readonly status: 'retry_scheduled'; readonly attempt: number; readonly nextAttemptAt: Date }
  | { readonly status: 'failed'; readonly attempt: number; readonly errorClass: 'permanent' | 'timeout' | 'retryable' }
  | { readonly status: 'lost_attempt_recovered'; readonly nextAttemptAt: Date | null };

export interface DriverInput {
  readonly store: ReturnType<typeof createDurableStore>;
  readonly executionId: string;
  readonly tenantId: string;
  readonly owner: string;
  readonly policy: RetryPolicy;
  readonly leaseMs: number;
  readonly timeoutMs: number;
  readonly clock: () => Date;
  /** Performs one attempt. Must be idempotent under the execution id and attempt number, because attempts can be repeated after a crash. */
  readonly step: (attempt: number, signal: AbortSignal) => Promise<void>;
}

const addMs = (date: Date, ms: number): Date => new Date(date.getTime() + ms);

async function withTimeout(work: Promise<void>, timeoutMs: number): Promise<void> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(Object.assign(new Error('attempt timed out'), { name: 'TimeoutError' }));
      controller.abort();
    }, timeoutMs);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Runs at most one attempt for one execution. Call it again after a crash or a retry delay: it resumes from
 * the persisted attempt count. Lease expiry is the only recovery signal, so two workers never run the same attempt
 * concurrently.
 */
export async function runDurableAttempt(input: DriverInput): Promise<DriverOutcome> {
  validateRetryPolicy(input.policy);
  const { store } = input;
  const now = input.clock();
  const leaseExpiresAt = addMs(now, input.leaseMs);
  const claimed: ExecutionRow | null = await store.claim(input.executionId, input.tenantId, input.owner, now, leaseExpiresAt);
  if (!claimed) return { status: 'not_claimable' };

  let version = claimed.version;
  // The attempt budget stored with the execution is authoritative, not the caller's policy.
  const policy: RetryPolicy = { ...input.policy, maxAttempts: claimed.maxAttempts };

  // An attempt that was started but never finished (its worker died while the lease was held) counts as a failed attempt.
  if (claimed.state === 'running') {
    const decision = decideAfterFailure('retryable', claimed.attempts, policy);
    if (decision.event === 'step_failed_permanent') {
      await store.transition({ executionId: input.executionId, tenantId: input.tenantId, owner: input.owner, expectedVersion: version,
        state: 'failed', attempts: claimed.attempts, nextAttemptAt: null, lastErrorClass: 'timeout', keepLease: false, leaseExpiresAt, now });
      return { status: 'failed', attempt: claimed.attempts, errorClass: 'timeout' };
    }
    const nextAttemptAt = now;
    version = await store.transition({ executionId: input.executionId, tenantId: input.tenantId, owner: input.owner, expectedVersion: version,
      state: 'retry_wait', attempts: claimed.attempts, nextAttemptAt, lastErrorClass: 'timeout', keepLease: false, leaseExpiresAt, now });
    return { status: 'lost_attempt_recovered', nextAttemptAt };
  }

  const attempt = claimed.attempts + 1;
  // Persist the intent before the side effect: a crash after this point is visible as a lost attempt.
  version = await store.transition({ executionId: input.executionId, tenantId: input.tenantId, owner: input.owner, expectedVersion: version,
    state: 'running', attempts: attempt, nextAttemptAt: null, lastErrorClass: null, keepLease: true, leaseExpiresAt, now });

  const controller = new AbortController();
  try {
    await withTimeout(input.step(attempt, controller.signal), input.timeoutMs);
  } catch (error) {
    const failure = classifyFailure(error);
    const errorName = error instanceof Error ? error.name : '';
    const isTimeout = errorName === 'TimeoutError';
    const decision = decideAfterFailure(failure, attempt, policy);
    const errorClass = isTimeout ? 'timeout' : failure;
    const done = input.clock();
    if (decision.event === 'step_failed_permanent') {
      await store.transition({ executionId: input.executionId, tenantId: input.tenantId, owner: input.owner, expectedVersion: version,
        state: 'failed', attempts: attempt, nextAttemptAt: null, lastErrorClass: errorClass === 'retryable' ? 'retryable' : errorClass,
        keepLease: false, leaseExpiresAt: addMs(done, input.leaseMs), now: done });
      return { status: 'failed', attempt, errorClass: errorClass === 'retryable' ? 'retryable' : errorClass };
    }
    const nextAttemptAt = addMs(done, decision.delayMs);
    await store.transition({ executionId: input.executionId, tenantId: input.tenantId, owner: input.owner, expectedVersion: version,
      state: 'retry_wait', attempts: attempt, nextAttemptAt, lastErrorClass: errorClass, keepLease: false,
      leaseExpiresAt: addMs(done, input.leaseMs), now: done });
    return { status: 'retry_scheduled', attempt, nextAttemptAt };
  }

  const done = input.clock();
  await store.transition({ executionId: input.executionId, tenantId: input.tenantId, owner: input.owner, expectedVersion: version,
    state: 'succeeded' satisfies ExecutionState, attempts: attempt, nextAttemptAt: null, lastErrorClass: null, keepLease: false,
    leaseExpiresAt: addMs(done, input.leaseMs), now: done });
  return { status: 'succeeded', attempt };
}

import { describe, expect, it } from 'vitest';
import { InvalidTransitionError, isTerminal, nextState } from './execution-state.js';
import { createIdempotentRunner, runWithRetry } from './execution-runner.js';
import { backoffDelayMs, classifyFailure, decideAfterFailure, RetryPolicyError, validateRetryPolicy } from './retry-policy.js';

const policy = { maxAttempts: 3, baseDelayMs: 100, maxDelayMs: 1000 };
const noWait = async (): Promise<void> => undefined;

function transient(message = 'upstream reset'): Error {
  return Object.assign(new Error(message), { code: 'ECONNRESET' });
}

describe('execution state machine', () => {
  it('follows the legal happy path', () => {
    let state = nextState('pending', 'start');
    state = nextState(state, 'request_approval');
    state = nextState(state, 'approve');
    state = nextState(state, 'step_succeeded');
    expect(state).toBe('succeeded');
    expect(isTerminal(state)).toBe(true);
  });

  it('rejects illegal transitions and never leaves terminal states', () => {
    expect(() => nextState('pending', 'step_succeeded')).toThrow(InvalidTransitionError);
    expect(() => nextState('succeeded', 'start')).toThrow(InvalidTransitionError);
    expect(() => nextState('cancelled', 'retry_due')).toThrow(InvalidTransitionError);
    expect(() => nextState('awaiting_approval', 'step_succeeded')).toThrow(InvalidTransitionError);
  });

  it('allows cancellation from every non-terminal state', () => {
    for (const state of ['pending', 'running', 'awaiting_approval', 'retry_wait'] as const) {
      expect(nextState(state, 'cancel')).toBe('cancelled');
    }
  });
});

describe('retry policy', () => {
  it('computes deterministic capped exponential backoff', () => {
    expect([1, 2, 3, 4].map((attempt) => backoffDelayMs(attempt, policy))).toEqual([100, 200, 400, 800]);
    expect(backoffDelayMs(10, policy)).toBe(1000);
  });

  it('validates policy bounds', () => {
    expect(() => validateRetryPolicy({ maxAttempts: 0, baseDelayMs: 1, maxDelayMs: 1 })).toThrow(RetryPolicyError);
    expect(() => validateRetryPolicy({ maxAttempts: 11, baseDelayMs: 1, maxDelayMs: 1 })).toThrow(RetryPolicyError);
    expect(() => validateRetryPolicy({ maxAttempts: 2, baseDelayMs: 500, maxDelayMs: 100 })).toThrow(RetryPolicyError);
  });

  it('classifies failures and fails closed on unknown errors', () => {
    expect(classifyFailure(transient())).toBe('retryable');
    expect(classifyFailure(Object.assign(new Error('x'), { retryable: true }))).toBe('retryable');
    expect(classifyFailure(Object.assign(new Error('slow'), { name: 'TimeoutError' }))).toBe('retryable');
    expect(classifyFailure(new Error('validation failed'))).toBe('permanent');
    expect(classifyFailure('plain string')).toBe('permanent');
    expect(classifyFailure(null)).toBe('permanent');
  });

  it('stops retrying once attempts are exhausted or the failure is permanent', () => {
    expect(decideAfterFailure('retryable', 1, policy)).toEqual({ event: 'step_failed_retryable', delayMs: 100 });
    expect(decideAfterFailure('retryable', 3, policy).event).toBe('step_failed_permanent');
    expect(decideAfterFailure('permanent', 1, policy).event).toBe('step_failed_permanent');
  });
});

describe('runWithRetry', () => {
  it('succeeds on the first attempt with a complete audit trail', async () => {
    const record = await runWithRetry({ step: async () => 'ok', policy, timeoutMs: 1000, sleep: noWait });
    expect(record).toMatchObject({ state: 'succeeded', attempts: 1, value: 'ok' });
    expect(record.trail).toEqual(['pending', 'running', 'succeeded']);
  });

  it('recovers from transient failures and records retry waits', async () => {
    const delays: number[] = [];
    const record = await runWithRetry({
      step: async (attempt) => { if (attempt < 3) throw transient(); return `done-${attempt}`; },
      policy,
      timeoutMs: 1000,
      sleep: async (ms) => { delays.push(ms); },
    });
    expect(record).toMatchObject({ state: 'succeeded', attempts: 3, value: 'done-3' });
    expect(delays).toEqual([100, 200]);
    expect(record.trail).toEqual(['pending', 'running', 'retry_wait', 'running', 'retry_wait', 'running', 'succeeded']);
  });

  it('fails permanently without retrying a non-transient error', async () => {
    let calls = 0;
    const record = await runWithRetry({
      step: async () => { calls += 1; throw new Error('invalid payload'); },
      policy, timeoutMs: 1000, sleep: noWait,
    });
    expect(calls).toBe(1);
    expect(record).toMatchObject({ state: 'failed', attempts: 1, error: 'invalid payload' });
  });

  it('exhausts retries and ends failed at maxAttempts', async () => {
    let calls = 0;
    const record = await runWithRetry({
      step: async () => { calls += 1; throw transient('still down'); },
      policy, timeoutMs: 1000, sleep: noWait,
    });
    expect(calls).toBe(3);
    expect(record).toMatchObject({ state: 'failed', attempts: 3, error: 'still down' });
  });

  it('times out a step that never settles and treats the timeout as retryable', async () => {
    const record = await runWithRetry({
      step: (_attempt, signal) => new Promise<never>((_, reject) => {
        signal.addEventListener('abort', () => reject(new Error('aborted')));
      }),
      policy: { maxAttempts: 2, baseDelayMs: 0, maxDelayMs: 0 },
      timeoutMs: 20,
      sleep: noWait,
    });
    expect(record).toMatchObject({ state: 'failed', attempts: 2 });
    expect(record.trail.filter((state) => state === 'retry_wait')).toHaveLength(1);
  });

  it('cancels before the first attempt when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    let calls = 0;
    const record = await runWithRetry({
      step: async () => { calls += 1; return 'never'; },
      policy, timeoutMs: 1000, signal: controller.signal, sleep: noWait,
    });
    expect(calls).toBe(0);
    expect(record).toMatchObject({ state: 'cancelled', attempts: 0 });
  });

  it('cancels during a retry wait without running another attempt', async () => {
    const controller = new AbortController();
    let calls = 0;
    const record = await runWithRetry({
      step: async () => { calls += 1; throw transient(); },
      policy,
      timeoutMs: 1000,
      signal: controller.signal,
      sleep: (_ms, signal) => new Promise<void>((_, reject) => {
        signal.addEventListener('abort', () => reject(new Error('sleep aborted')));
        controller.abort();
      }),
    });
    expect(calls).toBe(1);
    expect(record.state).toBe('cancelled');
    expect(record.trail.at(-1)).toBe('cancelled');
  });

  it('cancels a running step that ignores its abort signal', async () => {
    const controller = new AbortController();
    const pending = runWithRetry({
      step: () => new Promise<never>(() => undefined),
      policy, timeoutMs: 60_000, signal: controller.signal, sleep: noWait,
    });
    setTimeout(() => controller.abort(), 10);
    const record = await pending;
    expect(record.state).toBe('cancelled');
  });

  it('rejects invalid timeouts before running', async () => {
    await expect(runWithRetry({ step: async () => 1, policy, timeoutMs: 0 })).rejects.toThrow(RangeError);
  });
});

describe('idempotent runner', () => {
  it('runs a duplicate concurrent request once and shares the result', async () => {
    const runner = createIdempotentRunner();
    let executions = 0;
    const work = async (): Promise<string> => { executions += 1; await new Promise((r) => setTimeout(r, 5)); return 'result'; };
    const [a, b] = await Promise.all([runner.run('case-1:triage', work), runner.run('case-1:triage', work)]);
    expect([a, b]).toEqual(['result', 'result']);
    expect(executions).toBe(1);
  });

  it('returns the completed result for a later duplicate without re-executing', async () => {
    const runner = createIdempotentRunner();
    let executions = 0;
    await runner.run('key-a', async () => { executions += 1; return 1; });
    expect(await runner.run('key-a', async () => { executions += 1; return 2; })).toBe(1);
    expect(executions).toBe(1);
  });

  it('releases a failed key so a later retry can execute', async () => {
    const runner = createIdempotentRunner();
    await expect(runner.run('key-b', async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    expect(await runner.run('key-b', async () => 'recovered')).toBe('recovered');
  });

  it('rejects empty or oversized idempotency keys', async () => {
    const runner = createIdempotentRunner();
    await expect(runner.run('', async () => 1)).rejects.toThrow(RangeError);
    await expect(runner.run('x'.repeat(201), async () => 1)).rejects.toThrow(RangeError);
  });
});

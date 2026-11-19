import { type ExecutionEvent, type ExecutionState, nextState } from './execution-state.js';
import { classifyFailure, decideAfterFailure, type RetryPolicy, validateRetryPolicy } from './retry-policy.js';

export class TimeoutError extends Error {
  readonly name = 'TimeoutError';
}

export class CancelledError extends Error {
  readonly name = 'CancelledError';
}

export interface ExecutionRecord<T> {
  readonly state: ExecutionState;
  readonly attempts: number;
  readonly value?: T;
  readonly error?: string;
  /** Ordered audit trail of every state the execution entered. */
  readonly trail: readonly ExecutionState[];
}

export interface RunInput<T> {
  /** Receives the 1-based attempt number and an abort signal that fires on cancellation or timeout. */
  readonly step: (attempt: number, signal: AbortSignal) => Promise<T>;
  readonly policy: RetryPolicy;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
  /** Injected so tests do not wait on real clocks. */
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

const defaultSleep = (ms: number, signal: AbortSignal): Promise<void> => new Promise((resolve, reject) => {
  if (signal.aborted) return reject(new CancelledError('cancelled'));
  const timer = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve(); }, ms);
  const onAbort = (): void => { clearTimeout(timer); reject(new CancelledError('cancelled')); };
  signal.addEventListener('abort', onAbort, { once: true });
});

/** Rejects with TimeoutError after timeoutMs, and aborts the attempt's signal so the step can stop. */
async function runAttempt<T>(step: (signal: AbortSignal) => Promise<T>, timeoutMs: number, parent: AbortSignal): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const onParentAbort = (): void => controller.abort(new CancelledError('cancelled'));
  // Race against cancellation as well, so a step that ignores its signal cannot hang the execution.
  const cancelled = new Promise<never>((_, reject) => {
    parent.addEventListener('abort', () => { onParentAbort(); reject(new CancelledError('cancelled')); }, { once: true });
  });
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      // Settle the race with the timeout before aborting, so the step's own abort rejection cannot win the race.
      reject(new TimeoutError('step timed out'));
      controller.abort(new TimeoutError('step timed out'));
    }, timeoutMs);
  });
  try {
    return await Promise.race([step(controller.signal), timeout, cancelled]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Drives one step through the execution state machine with bounded retries.
 * Never throws for step failures: they are recorded in the returned state.
 */
export async function runWithRetry<T>(input: RunInput<T>): Promise<ExecutionRecord<T>> {
  const policy = validateRetryPolicy(input.policy);
  if (!Number.isInteger(input.timeoutMs) || input.timeoutMs <= 0) throw new RangeError('timeoutMs must be a positive integer');
  const signal = input.signal ?? new AbortController().signal;
  const sleep = input.sleep ?? defaultSleep;
  const trail: ExecutionState[] = ['pending'];
  let state: ExecutionState = 'pending';
  const move = (event: ExecutionEvent): void => {
    state = nextState(state, event);
    trail.push(state);
  };
  const finish = (attempts: number, extra: { value?: T; error?: string }): ExecutionRecord<T> =>
    ({ state, attempts, trail: [...trail], ...extra });

  if (signal.aborted) {
    move('cancel');
    return finish(0, {});
  }

  move('start');
  for (let attempt = 1; ; attempt += 1) {
    if (signal.aborted) {
      move('cancel');
      return finish(attempt - 1, {});
    }
    try {
      const value = await runAttempt((attemptSignal) => input.step(attempt, attemptSignal), input.timeoutMs, signal);
      move('step_succeeded');
      return finish(attempt, { value });
    } catch (error) {
      if (signal.aborted || error instanceof CancelledError) {
        move('cancel');
        return finish(attempt, {});
      }
      const decision = decideAfterFailure(classifyFailure(error), attempt, policy);
      const message = error instanceof Error ? error.message : 'unknown failure';
      if (decision.event === 'step_failed_permanent') {
        move('step_failed_permanent');
        return finish(attempt, { error: message });
      }
      move('step_failed_retryable');
      try {
        await sleep(decision.delayMs, signal);
      } catch {
        move('cancel');
        return finish(attempt, { error: message });
      }
      move('retry_due');
    }
  }
}

/**
 * Collapses duplicate requests with the same idempotency key into one execution.
 * Concurrent duplicates share the in-flight promise; a failed key is released so a later retry may run.
 */
export function createIdempotentRunner() {
  const inFlight = new Map<string, Promise<unknown>>();
  const completed = new Map<string, unknown>();
  return {
    async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
      if (key.length === 0 || key.length > 200) throw new RangeError('idempotency key must be 1 to 200 characters');
      if (completed.has(key)) return completed.get(key) as T;
      const existing = inFlight.get(key);
      if (existing !== undefined) return existing as Promise<T>;
      const promise = fn().then(
        (value) => { completed.set(key, value); inFlight.delete(key); return value; },
        (error: unknown) => { inFlight.delete(key); throw error; },
      );
      inFlight.set(key, promise);
      return promise;
    },
  };
}

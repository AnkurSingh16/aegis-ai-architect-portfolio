import { classifyFailure, decideAfterFailure, type RetryPolicy, validateRetryPolicy } from './retry-policy.js';
import type { ExecutionRow } from './durable-store.js';
import { createDurableStore } from './durable-store.js';
import type { WorkflowMetricsSink } from './workflow-metrics.js';

/**
 * Approval gate for side-effecting attempts. Every attempt needs its own approval: once consumed, a retry asks again.
 * The gate is backed by the tool approval store, so approvals are tenant-scoped and single-use.
 */
export interface ApprovalGate {
  createApproval(): Promise<string>;
  status(approvalId: string): Promise<'approved' | 'pending' | 'rejected' | 'expired' | 'consumed'>;
  consume(approvalId: string): Promise<boolean>;
}

export type DriverOutcome =
  | { readonly status: 'not_claimable' }
  | { readonly status: 'succeeded'; readonly attempt: number }
  | { readonly status: 'retry_scheduled'; readonly attempt: number; readonly nextAttemptAt: Date }
  | { readonly status: 'failed'; readonly attempt: number; readonly errorClass: 'permanent' | 'timeout' | 'retryable' }
  | { readonly status: 'lost_attempt_recovered'; readonly nextAttemptAt: Date }
  | { readonly status: 'approval_requested'; readonly approvalId: string }
  | { readonly status: 'cancelled'; readonly reason: 'requested' | 'approval_rejected' | 'approval_expired' | 'approval_already_consumed' };

/**
 * One record per driver call. It carries ids, the outcome and the error class only. It never carries step input, error
 * messages or approval ids, so a log line cannot leak what an attempt was working on.
 */
export interface DriverLogRecord {
  readonly event: 'durable_attempt';
  readonly executionId: string;
  readonly correlationId: string | null;
  /** Trace id from a valid upstream traceparent header, or null. Joins the line to an upstream trace. */
  readonly traceId: string | null;
  /** Wall-clock duration of this driver call, in milliseconds. */
  readonly durationMs: number;
  readonly outcome: DriverOutcome['status'] | 'error';
  readonly attempt?: number;
  readonly errorClass?: string;
  readonly reason?: string;
  readonly errorName?: string;
}

export type DriverLog = (record: DriverLogRecord) => void;

export interface DriverInput {
  readonly store: ReturnType<typeof createDurableStore>;
  readonly executionId: string;
  readonly tenantId: string;
  readonly owner: string;
  readonly policy: RetryPolicy;
  readonly leaseMs: number;
  readonly timeoutMs: number;
  readonly clock: () => Date;
  readonly approvalGate?: ApprovalGate;
  /** Optional. Receives one record per call. A logging failure never changes the outcome. */
  readonly log?: DriverLog;
  /** Carried on every log record, so one request can be followed through the driver. */
  readonly correlationId?: string | null;
  /** Carried on every log record. Null when the request carried no valid traceparent. */
  readonly traceId?: string | null;
  /** Optional. Receives one sample per call. A metrics failure never changes the outcome. */
  readonly metrics?: WorkflowMetricsSink;
  /** Performs one attempt. Must be idempotent under the execution id and attempt number, because attempts can be repeated after a crash. */
  readonly step: (attempt: number, signal: AbortSignal) => Promise<void>;
}

const addMs = (date: Date, ms: number): Date => new Date(date.getTime() + ms);

async function withTimeout(work: Promise<void>, timeoutMs: number, controller: AbortController): Promise<void> {
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
 * Runs at most one step for one execution per call, or handles one waiting condition (approval, cancellation).
 * Call it again after a crash, a retry delay or an approval. It resumes from the persisted state.
 */
export async function runDurableAttempt(input: DriverInput): Promise<DriverOutcome> {
  const correlationId = input.correlationId ?? null;
  const traceId = input.traceId ?? null;
  const started = performance.now();
  const emit = (record: Omit<DriverLogRecord, 'event' | 'executionId' | 'correlationId' | 'traceId' | 'durationMs'>) => {
    const durationMs = Math.round((performance.now() - started) * 1000) / 1000;
    try {
      input.metrics?.recordAttempt({ outcome: record.outcome, durationMs });
    } catch {
      // Metrics must not turn a committed outcome into an error for the caller.
    }
    if (!input.log) return;
    try {
      input.log({ event: 'durable_attempt', executionId: input.executionId, correlationId, traceId, durationMs, ...record });
    } catch {
      // Logging must not turn a committed outcome into an error for the caller.
    }
  };
  let outcome: DriverOutcome;
  try {
    outcome = await attemptOnce(input);
  } catch (error) {
    emit({ outcome: 'error', errorName: error instanceof Error ? error.name : 'unknown' });
    throw error;
  }
  emit({
    outcome: outcome.status,
    ...('attempt' in outcome ? { attempt: outcome.attempt } : {}),
    ...('errorClass' in outcome ? { errorClass: outcome.errorClass } : {}),
    ...('reason' in outcome ? { reason: outcome.reason } : {}),
  });
  return outcome;
}

async function attemptOnce(input: DriverInput): Promise<DriverOutcome> {
  validateRetryPolicy(input.policy);
  const { store, tenantId, executionId, owner } = input;
  const now = input.clock();
  const leaseExpiresAt = addMs(now, input.leaseMs);
  const claimed: ExecutionRow | null = await store.claim(executionId, tenantId, owner, now, leaseExpiresAt);
  if (!claimed) return { status: 'not_claimable' };
  // The attempt budget stored with the execution is authoritative, not the caller's policy.
  const policy: RetryPolicy = { ...input.policy, maxAttempts: claimed.maxAttempts };
  let version = claimed.version;

  const cancelNow = async (reason: 'requested' | 'approval_rejected' | 'approval_expired' | 'approval_already_consumed', at: Date) => {
    await store.transition({ executionId, tenantId, owner, expectedVersion: version, state: 'cancelled', attempts: claimed.attempts,
      nextAttemptAt: null, lastErrorClass: 'cancelled', keepLease: false, leaseExpiresAt: at, now: at });
    return { status: 'cancelled' as const, reason };
  };

  if (claimed.cancelRequested) return cancelNow('requested', now);

  // An attempt that was started but never finished (its worker died while the lease was held) counts as a failed attempt.
  if (claimed.state === 'running') {
    const decision = decideAfterFailure('retryable', claimed.attempts, policy);
    if (decision.event === 'step_failed_permanent') {
      await store.transition({ executionId, tenantId, owner, expectedVersion: version, state: 'failed', attempts: claimed.attempts,
        nextAttemptAt: null, lastErrorClass: 'timeout', keepLease: false, leaseExpiresAt, now });
      return { status: 'failed', attempt: claimed.attempts, errorClass: 'timeout' };
    }
    await store.transition({ executionId, tenantId, owner, expectedVersion: version, state: 'retry_wait', attempts: claimed.attempts,
      nextAttemptAt: now, lastErrorClass: 'timeout', keepLease: false, leaseExpiresAt, now });
    return { status: 'lost_attempt_recovered', nextAttemptAt: now };
  }

  // Approval gate: a side-effecting attempt waits for a human decision before it may start.
  let consumeApproval = false;
  if (input.approvalGate) {
    if (!claimed.approvalGranted || claimed.approvalId === null) {
      const approvalId = await input.approvalGate.createApproval();
      await store.transition({ executionId, tenantId, owner, expectedVersion: version, state: 'awaiting_approval', attempts: claimed.attempts,
        nextAttemptAt: null, lastErrorClass: null, keepLease: false, leaseExpiresAt, now, approval: { kind: 'request', approvalId } });
      return { status: 'approval_requested', approvalId };
    }
    const decision = await input.approvalGate.status(claimed.approvalId);
    if (decision === 'consumed') return cancelNow('approval_already_consumed', now);
    if (decision !== 'approved') {
      return cancelNow(decision === 'expired' ? 'approval_expired' : 'approval_rejected', now);
    }
    if (!(await input.approvalGate.consume(claimed.approvalId))) return cancelNow('approval_already_consumed', now);
    consumeApproval = true;
  }

  const attempt = claimed.attempts + 1;
  // Persist the intent before the side effect: a crash after this point is visible as a lost attempt.
  version = await store.transition({ executionId, tenantId, owner, expectedVersion: version, state: 'running', attempts: attempt,
    nextAttemptAt: null, lastErrorClass: null, keepLease: true, leaseExpiresAt, now,
    approval: consumeApproval ? { kind: 'consume' } : { kind: 'keep' } });

  const controller = new AbortController();
  try {
    await withTimeout(input.step(attempt, controller.signal), input.timeoutMs, controller);
  } catch (error) {
    const isTimeout = error instanceof Error && error.name === 'TimeoutError';
    const failure = isTimeout ? 'timeout' : classifyFailure(error);
    const done = input.clock();
    if (await store.isCancelRequested(executionId, tenantId)) {
      await store.transition({ executionId, tenantId, owner, expectedVersion: version, state: 'cancelled', attempts: attempt,
        nextAttemptAt: null, lastErrorClass: 'cancelled', keepLease: false, leaseExpiresAt: addMs(done, input.leaseMs), now: done });
      return { status: 'cancelled', reason: 'requested' };
    }
    const decision = decideAfterFailure(failure === 'timeout' ? 'retryable' : failure, attempt, policy);
    if (decision.event === 'step_failed_permanent') {
      const errorClass = failure === 'timeout' ? 'timeout' : failure === 'retryable' ? 'retryable' : 'permanent';
      await store.transition({ executionId, tenantId, owner, expectedVersion: version, state: 'failed', attempts: attempt,
        nextAttemptAt: null, lastErrorClass: errorClass, keepLease: false, leaseExpiresAt: addMs(done, input.leaseMs), now: done });
      return { status: 'failed', attempt, errorClass };
    }
    const nextAttemptAt = addMs(done, decision.delayMs);
    await store.transition({ executionId, tenantId, owner, expectedVersion: version, state: 'retry_wait', attempts: attempt,
      nextAttemptAt, lastErrorClass: failure === 'timeout' ? 'timeout' : failure, keepLease: false,
      leaseExpiresAt: addMs(done, input.leaseMs), now: done });
    return { status: 'retry_scheduled', attempt, nextAttemptAt };
  }

  // The side effect completed. Success is recorded even if cancellation was requested meanwhile.
  const done = input.clock();
  await store.transition({ executionId, tenantId, owner, expectedVersion: version, state: 'succeeded', attempts: attempt,
    nextAttemptAt: null, lastErrorClass: null, keepLease: false, leaseExpiresAt: addMs(done, input.leaseMs), now: done });
  return { status: 'succeeded', attempt };
}

export type ApprovalWaitResult = 'not_awaiting' | 'waiting' | 'granted' | 'rejected' | 'expired';

/** Applies a human approval decision to an execution that is waiting for one. Does not need a lease. */
export async function resumeApprovalWait(input: {
  store: ReturnType<typeof createDurableStore>; executionId: string; tenantId: string;
  gate: ApprovalGate; clock: () => Date;
}): Promise<ApprovalWaitResult> {
  const loaded = await input.store.load(input.executionId, input.tenantId);
  if (!loaded || loaded.execution.state !== 'awaiting_approval' || loaded.execution.approvalId === null) return 'not_awaiting';
  const decision = await input.gate.status(loaded.execution.approvalId);
  if (decision === 'pending') return 'waiting';
  const now = input.clock();
  if (decision === 'approved') {
    const moved = await input.store.resolveApproval(input.executionId, input.tenantId, loaded.execution.version, 'granted', now);
    return moved ? 'granted' : 'not_awaiting';
  }
  const moved = await input.store.resolveApproval(input.executionId, input.tenantId, loaded.execution.version, 'rejected', now);
  if (!moved) return 'not_awaiting';
  return decision === 'expired' ? 'expired' : 'rejected';
}

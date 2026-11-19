/**
 * Typed execution states and the only legal transitions between them.
 * Pure logic: no I/O, no persistence. Durable checkpoints are a separate, later slice.
 */
export const executionStates = [
  'pending',
  'running',
  'awaiting_approval',
  'retry_wait',
  'succeeded',
  'failed',
  'cancelled',
] as const;
export type ExecutionState = typeof executionStates[number];

export const executionEvents = [
  'start',
  'request_approval',
  'approve',
  'reject',
  'step_succeeded',
  'step_failed_retryable',
  'step_failed_permanent',
  'retry_due',
  'cancel',
  'operator_requeue',
] as const;
export type ExecutionEvent = typeof executionEvents[number];

type TransitionTable = Readonly<Record<ExecutionState, Readonly<Partial<Record<ExecutionEvent, ExecutionState>>>>>;

const transitions: TransitionTable = {
  pending: { start: 'running', cancel: 'cancelled' },
  running: {
    request_approval: 'awaiting_approval',
    step_succeeded: 'succeeded',
    step_failed_retryable: 'retry_wait',
    step_failed_permanent: 'failed',
    cancel: 'cancelled',
  },
  // An approval makes the waiting attempt due again. It does not start an attempt by itself.
  awaiting_approval: { approve: 'retry_wait', reject: 'cancelled', cancel: 'cancelled' },
  retry_wait: { retry_due: 'running', cancel: 'cancelled' },
  succeeded: {},
  // A human operator may requeue a dead-lettered execution for one more attempt. Nothing else leaves 'failed'.
  failed: { operator_requeue: 'retry_wait' },
  cancelled: {},
};

export class InvalidTransitionError extends Error {
  readonly name = 'InvalidTransitionError';
  constructor(readonly from: ExecutionState, readonly event: ExecutionEvent) {
    super(`Illegal execution transition: ${from} --${event}-->`);
  }
}

export function isTerminal(state: ExecutionState): boolean {
  return Object.keys(transitions[state]).length === 0;
}

/** Returns the next state, or throws InvalidTransitionError. Never mutates anything. */
export function nextState(current: ExecutionState, event: ExecutionEvent): ExecutionState {
  const next = transitions[current][event];
  if (next === undefined) throw new InvalidTransitionError(current, event);
  return next;
}

import { describe, expect, it } from 'vitest';
import { InvalidTransitionError, isTerminal, nextState } from './execution-state.js';

describe('operator requeue', () => {
  it('moves a failed execution back to retry_wait and only that way', () => {
    expect(nextState('failed', 'operator_requeue')).toBe('retry_wait');
    expect(isTerminal('failed')).toBe(false);
    for (const event of ['start', 'retry_due', 'cancel', 'step_succeeded'] as const) {
      expect(() => nextState('failed', event)).toThrow(InvalidTransitionError);
    }
  });

  it('keeps succeeded and cancelled terminal and refuses requeue from them', () => {
    expect(isTerminal('succeeded')).toBe(true);
    expect(isTerminal('cancelled')).toBe(true);
    expect(() => nextState('succeeded', 'operator_requeue')).toThrow(InvalidTransitionError);
    expect(() => nextState('cancelled', 'operator_requeue')).toThrow(InvalidTransitionError);
  });
});

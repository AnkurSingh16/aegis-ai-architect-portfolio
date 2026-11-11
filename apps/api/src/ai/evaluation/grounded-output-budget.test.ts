import { describe, expect, it } from 'vitest';
import { approvedGroundedOutputBudgets, requireApprovedGroundedOutputBudget } from './grounded-output-budget.js';

describe('approved grounded generation budgets', () => {
  it('allows only the reviewed 256 and 512 budgets', () => {
    expect(approvedGroundedOutputBudgets).toEqual([256, 512]);
    expect(requireApprovedGroundedOutputBudget(256)).toBe(256);
    expect(requireApprovedGroundedOutputBudget(512)).toBe(512);
    for (const value of [0, 128, 257, 1024, '512', null, undefined]) {
      expect(() => requireApprovedGroundedOutputBudget(value)).toThrow(/not approved/);
    }
  });
});

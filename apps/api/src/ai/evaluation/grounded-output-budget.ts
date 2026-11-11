export const approvedGroundedOutputBudgets = [256, 512] as const;
export type ApprovedGroundedOutputBudget = typeof approvedGroundedOutputBudgets[number];

/** Rejects all values other than the two reviewed budgets before request construction. */
export function requireApprovedGroundedOutputBudget(value: unknown): ApprovedGroundedOutputBudget {
  if (typeof value !== 'number' || !approvedGroundedOutputBudgets.includes(value as ApprovedGroundedOutputBudget)) {
    throw new Error('Grounded output token budget is not approved.');
  }
  return value as ApprovedGroundedOutputBudget;
}

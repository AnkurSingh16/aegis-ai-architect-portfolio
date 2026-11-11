import { describe, expect, it } from 'vitest';
import { assertApprovedTokenBudgetRuntime, safeTokenBudgetCliFailure, tokenBudgetReportExitCode } from './run-grounded-token-budget-512-local-evaluation.js';

describe('M4.15 evaluation CLI lifecycle', () => {
  it('returns success only for completed execution with accepted outputs', () => {
    expect(tokenBudgetReportExitCode({ executionStatus: 'completed', contractAcceptanceStatus: 'passed' })).toBe(0);
    expect(tokenBudgetReportExitCode({ executionStatus: 'completed', contractAcceptanceStatus: 'failed' })).toBe(1);
    expect(tokenBudgetReportExitCode({ executionStatus: 'incomplete', contractAcceptanceStatus: 'passed' })).toBe(1);
  });

  it('reports only fixed lifecycle stages, never exception text', () => {
    expect(safeTokenBudgetCliFailure('provider_evaluation')).toBe(
      '{"event":"grounded_token_budget_512_evaluation_cli_failure","failureStage":"provider_evaluation"}');
    expect(safeTokenBudgetCliFailure('secret response body')).toBe(
      '{"event":"grounded_token_budget_512_evaluation_cli_failure","failureStage":"unknown"}');
  });

  it('rejects any model, timeout, or concurrency outside the local one-request contract', () => {
    expect(() => assertApprovedTokenBudgetRuntime({ model: 'qwen2.5:3b-instruct', timeoutMs: 15000, maxConcurrent: 1 })).not.toThrow();
    expect(() => assertApprovedTokenBudgetRuntime({ model: 'other-model', timeoutMs: 15000, maxConcurrent: 1 })).toThrow();
    expect(() => assertApprovedTokenBudgetRuntime({ model: 'qwen2.5:3b-instruct', timeoutMs: 15001, maxConcurrent: 1 })).toThrow();
    expect(() => assertApprovedTokenBudgetRuntime({ model: 'qwen2.5:3b-instruct', timeoutMs: 15000, maxConcurrent: 2 })).toThrow();
    expect(() => assertApprovedTokenBudgetRuntime(undefined)).toThrow();
  });
});

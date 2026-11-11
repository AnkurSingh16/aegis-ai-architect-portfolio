import { describe, expect, it } from 'vitest';
import { groundedBalancedReportRelativePath, safeBalancedCliFailure } from './run-grounded-balanced-local-evaluation.js';
import { groundedContextEvaluationReportRelativePath, groundedEvaluationV1ReportRelativePath,
  groundedEvaluationV2ReportRelativePath, groundedEvaluationV3ReportRelativePath } from './run-grounded-local-evaluation.js';

describe('balanced evaluation CLI lifecycle metadata', () => {
  it('uses a distinct one-time report path and retains prior evaluation report identities', () => {
    expect(groundedBalancedReportRelativePath).toBe('.local/evaluations/milestone-4.12-grounded-balanced-qwen2.5-3b-instruct-v1.json');
    expect(new Set([groundedBalancedReportRelativePath, groundedContextEvaluationReportRelativePath,
      groundedEvaluationV1ReportRelativePath, groundedEvaluationV2ReportRelativePath, groundedEvaluationV3ReportRelativePath]).size).toBe(5);
  });

  it('reports only a fixed lifecycle stage and never echoes unsafe failure data', () => {
    const secret = 'raw provider response and credential marker';
    expect(safeBalancedCliFailure('provider_evaluation')).toBe(JSON.stringify({
      event: 'grounded_balanced_evaluation_cli_failure', failureStage: 'provider_evaluation',
    }));
    expect(safeBalancedCliFailure(secret)).toBe(JSON.stringify({ event: 'grounded_balanced_evaluation_cli_failure', failureStage: 'unknown' }));
    expect(safeBalancedCliFailure(secret)).not.toContain(secret);
  });
});

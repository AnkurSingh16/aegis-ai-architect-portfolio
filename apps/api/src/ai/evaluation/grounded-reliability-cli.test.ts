import { describe, expect, it } from 'vitest';
import { reliabilityReportExitCode, safeReliabilityCliFailure } from './run-grounded-reliability-local-evaluation.js';

describe('grounded reliability evaluation CLI lifecycle', () => {
  it('returns success only for a completed execution with contract acceptance', () => {
    expect(reliabilityReportExitCode({ executionStatus: 'completed', contractAcceptanceStatus: 'passed' })).toBe(0);
    expect(reliabilityReportExitCode({ executionStatus: 'completed', contractAcceptanceStatus: 'failed' })).toBe(1);
    expect(reliabilityReportExitCode({ executionStatus: 'incomplete', contractAcceptanceStatus: 'passed' })).toBe(1);
  });

  it('reports only a fixed lifecycle failure stage', () => {
    expect(safeReliabilityCliFailure('provider_evaluation')).toBe(
      '{"event":"grounded_reliability_evaluation_cli_failure","failureStage":"provider_evaluation"}');
    expect(safeReliabilityCliFailure('summary_output')).toBe(
      '{"event":"grounded_reliability_evaluation_cli_failure","failureStage":"summary_output"}');
    expect(safeReliabilityCliFailure('private provider response and credentials')).toBe(
      '{"event":"grounded_reliability_evaluation_cli_failure","failureStage":"unknown"}');
  });
});

import { describe, expect, it } from 'vitest';
import { groundedBalancedScenarios } from './grounded-balanced-dataset.js';
import { createBalancedObservation } from './grounded-balanced-scoring.js';
import { createGroundedBalancedReportV2, groundedBalancedReportV2RelativePath, groundedBalancedReportV2SchemaVersion } from './grounded-balanced-report-v2.js';
import type { BalancedRun } from './grounded-balanced-runner.js';

const identity = { codeCommit: 'a'.repeat(40), treeHash: 'b'.repeat(40), sourceRef: 'origin/main', reviewedRefCommit: 'c'.repeat(40) };

function runWithFailure(): BalancedRun {
  const observations = groundedBalancedScenarios.map((scenario, index) => index === 2
    ? createBalancedObservation(scenario, 'failure', { parsedJson: false, failureStage: 'model_json_parse',
      correlationComplete: true, latencyMs: 120, providerDiagnostics: { failureStage: 'model_json_parse', validationReason: null,
        envelopeBytes: 60, modelOutputBytes: 1, promptTokens: 32, generatedTokens: 256, completionReason: 'length',
        outputLimitReached: true, latencyMs: 120, correlationComplete: true } })
    : createBalancedObservation(scenario, 'success', { parsedJson: true, schemaAccepted: true, groundingState: 'INSUFFICIENT_EVIDENCE',
      citationsValid: null, humanReviewRequired: true, correlationComplete: true, latencyMs: 90, promptTokens: 20, generatedTokens: 30 }));
  const attempts = groundedBalancedScenarios.map((scenario, index) => ({ scenarioId: scenario.scenarioId,
    status: index === 2 ? 'failure' as const : 'success' as const,
    ...(index === 2 ? { failureStage: 'model_json_parse' } : { groundingState: 'INSUFFICIENT_EVIDENCE' as const,
      citationCount: 0, humanReviewRequired: true as const }), latencyMs: 90, promptTokens: null, generatedTokens: null,
    correlationComplete: true }));
  return { attempts, observations, stopped: false };
}

describe('versioned grounded balanced report v2', () => {
  it('can pass the output contract while leaving decision quality unrated', () => {
    const observations = groundedBalancedScenarios.map((scenario) => createBalancedObservation(scenario, 'success', {
      parsedJson: true, schemaAccepted: true, groundingState: 'INSUFFICIENT_EVIDENCE', citationsValid: null,
      humanReviewRequired: true, correlationComplete: true,
    }));
    const attempts = groundedBalancedScenarios.map((scenario) => ({ scenarioId: scenario.scenarioId, status: 'success' as const,
      groundingState: 'INSUFFICIENT_EVIDENCE' as const, citationCount: 0, humanReviewRequired: true as const,
      latencyMs: null, promptTokens: null, generatedTokens: null, correlationComplete: true }));
    const report = createGroundedBalancedReportV2({ source: identity, model: 'qwen2.5:3b-instruct',
      run: { attempts, observations, stopped: false } });
    expect(report).toMatchObject({ executionStatus: 'completed', contractAcceptanceStatus: 'passed', decisionQualityStatus: 'not_rated' });
  });

  it('does not call a duplicate or missing scenario set a completed accepted run', () => {
    const observations = groundedBalancedScenarios.map((scenario) => createBalancedObservation(scenario, 'success', {
      parsedJson: true, schemaAccepted: true, groundingState: 'INSUFFICIENT_EVIDENCE', humanReviewRequired: true,
    }));
    const attempts = groundedBalancedScenarios.map((scenario) => ({ scenarioId: scenario.scenarioId, status: 'success' as const,
      groundingState: 'INSUFFICIENT_EVIDENCE' as const, citationCount: 0, humanReviewRequired: true as const,
      latencyMs: null, promptTokens: null, generatedTokens: null, correlationComplete: true }));
    observations[5] = { ...observations[5]!, scenarioId: observations[4]!.scenarioId };
    const report = createGroundedBalancedReportV2({ source: identity, model: 'qwen2.5:3b-instruct',
      run: { attempts, observations, stopped: false } });
    expect(report).toMatchObject({ executionStatus: 'incomplete', contractAcceptanceStatus: 'incomplete' });
  });

  it('separates complete execution, contract failure, and unrated decision quality', () => {
    const report = createGroundedBalancedReportV2({ source: identity, model: 'qwen2.5:3b-instruct', run: runWithFailure() });
    expect(report.reportSchemaVersion).toBe(groundedBalancedReportV2SchemaVersion);
    expect(report).toMatchObject({ executionStatus: 'completed', contractAcceptanceStatus: 'failed', decisionQualityStatus: 'not_rated',
      decisionQualityCriteria: { state: 'not_predeclared' }, plannedAttempts: 6 });
    expect(report.score.metrics.jsonParsing).toEqual({ numerator: 5, denominator: 6, rate: 0.8333, state: 'measured' });
    expect(report.attempts[2]?.diagnostics).toMatchObject({ failureStage: 'model_json_parse', completionReason: 'length',
      outputLimitReached: true, generatedTokens: 256 });
  });

  it('uses a fresh report identity and serializes only sanitized attempt fields', () => {
    const report = createGroundedBalancedReportV2({ source: identity, model: 'qwen2.5:3b-instruct', run: runWithFailure() });
    const json = JSON.stringify(report);
    expect(groundedBalancedReportV2RelativePath).toBe('.local/evaluations/milestone-4.14-grounded-reliability-qwen2.5-3b-instruct-v1.json');
    expect(json).not.toContain('UNTRUSTED_PROMPT_MARKER');
    expect(json).not.toContain('Rationale case fact secret');
    expect(json).not.toContain('caseFacts');
    expect(json).not.toContain('source content');
    expect(json).not.toContain('"citations"');
    expect(json).not.toContain('raw response');
  });
});

import { describe, expect, it } from 'vitest';
import { groundedBalancedScenarios } from './grounded-balanced-dataset.js';
import { createBalancedObservation } from './grounded-balanced-scoring.js';
import { createGroundedTokenBudget512Report, groundedTokenBudget512ReportRelativePath,
  groundedTokenBudget512ReportSchemaVersion } from './grounded-token-budget-report.js';
import type { BalancedRun } from './grounded-balanced-runner.js';

const source = { codeCommit: 'a'.repeat(40), treeHash: 'b'.repeat(40), sourceRef: 'origin/main', reviewedRefCommit: 'c'.repeat(40) };

function syntheticRun(): BalancedRun {
  const observations = groundedBalancedScenarios.map((scenario) => createBalancedObservation(scenario, 'success', {
    parsedJson: true, schemaAccepted: true, groundingState: scenario.expectedGroundingState,
    citationsValid: scenario.expectedGroundingState === 'SUPPORTED' ? true : null,
    citedExpectedSourceIdentities: [...scenario.expectedSourceIdentities], humanReviewRequired: true, correlationComplete: true,
    providerDiagnostics: { failureStage: null, validationReason: null, envelopeBytes: 100, modelOutputBytes: 80,
      promptTokens: 300, generatedTokens: 140, completionReason: 'stop', outputLimitReached: false, latencyMs: 900,
      correlationComplete: true },
    ...(scenario.expected ? { category: scenario.expected.category, priority: scenario.expected.priority,
      recommendedTeam: scenario.expected.recommendedTeam, nextAction: scenario.expected.nextAction } : {}),
  }));
  const attempts = groundedBalancedScenarios.map((scenario) => ({ scenarioId: scenario.scenarioId, status: 'success' as const,
    groundingState: scenario.expectedGroundingState, ...(scenario.expected ? scenario.expected : {}), citationCount: scenario.expected ? 2 : 0,
    humanReviewRequired: true as const, latencyMs: 900, promptTokens: 300, generatedTokens: 140, correlationComplete: true }));
  return { attempts, observations, stopped: false };
}

describe('M4.15 token-budget report v1', () => {
  it('records the isolated generation setting and preserves execution/contract/quality distinctions', () => {
    const report = createGroundedTokenBudget512Report({ source, run: syntheticRun() });
    expect(report).toMatchObject({ reportSchemaVersion: groundedTokenBudget512ReportSchemaVersion,
      evaluatorVersion: 'aegis-grounded-token-budget-512-v1', datasetVersion: 'aegis-grounded-balanced-v1',
      source: { codeCommit: source.codeCommit, treeHash: source.treeHash,
        reviewedBranch: 'origin/feat/m4-grounded-token-budget-experiment' },
      generation: { numPredict: 512, temperature: 0.1, timeoutMs: 15000, maxConcurrent: 1, maxAttempts: 6, retryCount: 0 },
      executionStatus: 'completed', contractAcceptanceStatus: 'passed', decisionQualityStatus: 'not_rated',
      comparison: { pairedWithinRun: false } });
    expect(report.attempts).toHaveLength(6);
    expect(report.attempts[0]).toMatchObject({ scenarioId: 'BALANCED-LOGIN-201', expectedGroundingState: 'SUPPORTED',
      actualGroundingState: 'SUPPORTED', jsonParsed: true, contractAccepted: true, citationsValid: true,
      expectedSourceCoverage: { numerator: 2, denominator: 2 }, humanReviewEnforced: true,
      diagnostics: { generatedTokens: 140, completionReason: 'stop', outputLimitReached: false } });
  });

  it('uses a fresh path and excludes facts, source text, rationale, citations, and raw output', () => {
    const json = JSON.stringify(createGroundedTokenBudget512Report({ source, run: syntheticRun() }));
    expect(groundedTokenBudget512ReportRelativePath).toBe(
      '.local/evaluations/milestone-4.15-grounded-token-budget-512-qwen2.5-3b-instruct-v1.json');
    expect(json).not.toContain('The Synthetic North training workspace');
    expect(json).not.toContain('For this invented evaluation');
    expect(json).not.toContain('reviewRationale');
    expect(json).not.toContain('"citations":');
    expect(json).not.toContain('raw response');
  });
});

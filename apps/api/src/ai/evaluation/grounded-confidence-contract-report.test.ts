import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { groundedBalancedScenarios } from './grounded-balanced-dataset.js';
import { createBalancedObservation } from './grounded-balanced-scoring.js';
import { createGroundedConfidenceContractReport, groundedConfidenceContractPromptVariant,
  groundedConfidenceContractReportRelativePath, groundedConfidenceContractReportSchemaVersion } from './grounded-confidence-contract-report.js';
import { reservePrivateReport, writePrivateReport } from './private-report.js';
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

describe('M4.17 confidence-contract report v1', () => {
  it('records the prompt variant, source identity, fixed settings and distinct quality status', () => {
    const report = createGroundedConfidenceContractReport({ source, run: syntheticRun() });
    expect(report).toMatchObject({ reportSchemaVersion: groundedConfidenceContractReportSchemaVersion,
      evaluatorVersion: 'aegis-grounded-confidence-contract-v1', datasetVersion: 'aegis-grounded-balanced-v1',
      source: { codeCommit: source.codeCommit, treeHash: source.treeHash,
        reviewedBranch: 'origin/feat/m4-grounded-confidence-contract' },
      model: 'qwen2.5:3b-instruct', promptVariant: groundedConfidenceContractPromptVariant,
      generation: { numPredict: 512, temperature: 0.1, timeoutMs: 15000, maxConcurrent: 1, maxAttempts: 6, retryCount: 0 },
      decisionQualityStatus: 'not_rated' });
    expect(report.attempts).toHaveLength(6);
    expect(report.attempts[0]).toMatchObject({ scenarioId: 'BALANCED-LOGIN-201', expectedGroundingState: 'SUPPORTED',
      actualGroundingState: 'SUPPORTED', jsonParsed: true, contractAccepted: true, citationsValid: true,
      expectedSourceCoverage: { numerator: 2, denominator: 2 }, humanReviewEnforced: true,
      diagnostics: { generatedTokens: 140, completionReason: 'stop', outputLimitReached: false } });
  });

  it('uses a fresh, versioned path and excludes confidence values, facts, sources, rationale and raw output', () => {
    const json = JSON.stringify(createGroundedConfidenceContractReport({ source, run: syntheticRun() }));
    expect(groundedConfidenceContractReportRelativePath).toBe(
      '.local/evaluations/milestone-4.17-grounded-confidence-contract-qwen2.5-3b-instruct-v1.json');
    expect(json).not.toContain('The Synthetic North training workspace');
    expect(json).not.toContain('For this invented evaluation');
    expect(json).not.toContain('reviewRationale');
    expect(json).not.toContain('confidence":0.');
    expect(json).not.toContain('"citations":');
    expect(json).not.toContain('raw response');
  });

  it('uses the private exclusive reservation contract without touching the real report path', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aegis-confidence-report-'));
    const temporaryReport = join(root, 'private', 'report.json');
    const contents = { reportSchemaVersion: groundedConfidenceContractReportSchemaVersion, status: 'reserved' };
    try {
      const handle = await reservePrivateReport(temporaryReport);
      try { await writePrivateReport(handle, contents); }
      finally { await handle.close(); }
      const before = await readFile(temporaryReport, 'utf8');
      expect((await stat(temporaryReport)).mode & 0o777).toBe(0o600);
      await expect(reservePrivateReport(temporaryReport)).rejects.toMatchObject({ code: 'EEXIST' });
      expect(await readFile(temporaryReport, 'utf8')).toBe(before);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});

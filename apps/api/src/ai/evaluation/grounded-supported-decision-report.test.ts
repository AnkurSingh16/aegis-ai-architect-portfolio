import { afterEach, describe, expect, it } from 'vitest';
import { chmod, mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { groundedBalancedScenarios } from './grounded-balanced-dataset.js';
import { createBalancedObservation } from './grounded-balanced-scoring.js';
import { createGroundedSupportedDecisionReport, groundedSupportedDecisionReportRelativePath } from './grounded-supported-decision-report.js';
import { reservePrivateReport } from './private-report.js';

const temporaryRoots: string[] = [];
afterEach(async () => { await Promise.all(temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

function pendingRun() {
  return { stopped: false,
    attempts: groundedBalancedScenarios.map((scenario) => ({ scenarioId: scenario.scenarioId, status: 'not_attempted' as const,
      latencyMs: null, promptTokens: null, generatedTokens: null, correlationComplete: false })),
    observations: groundedBalancedScenarios.map((scenario) => createBalancedObservation(scenario, 'not_attempted')) };
}

describe('M4.18 supported-decision report', () => {
  it('uses a fresh versioned path and records descriptive comparisons with decision quality unrated', () => {
    expect(groundedSupportedDecisionReportRelativePath).toBe(
      '.local/evaluations/milestone-4.18-grounded-supported-decision-qwen2.5-3b-instruct-v1.json');
    const report = createGroundedSupportedDecisionReport({ source: { codeCommit: 'a'.repeat(40), treeHash: 'b'.repeat(40),
      sourceRef: 'origin/main', reviewedRefCommit: 'c'.repeat(40) }, run: pendingRun() });
    expect(report).toMatchObject({ reportSchemaVersion: 'aegis-grounded-supported-decision-report-v1',
      datasetVersion: 'aegis-grounded-balanced-v1', model: 'qwen2.5:3b-instruct', plannedAttempts: 6,
      decisionQualityStatus: 'not_rated', comparisonPlan: { primaryBaseline: { evaluator: 'M4.15' },
        historicalContext: { evaluator: 'M4.17' }, pairedInputs: false, causalClaim: false } });
    expect(report.comparisonPlan.metrics).toContain('supportedCoverage');
    expect(report.comparisonPlan.metrics).toContain('correctAbstentionAgreement');
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain('caseFacts');
    expect(serialized).not.toContain('reviewRationale');
    expect(serialized).not.toContain('Synthetic North training workspace');
    expect(serialized).not.toContain('EVAL-NORTH-LOGIN-SEVERITY-V1');
  });

  it('reserves only a versioned temp path exclusively and rejects any repeat without overwriting', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aegis-m418-report-'));
    temporaryRoots.push(root);
    await chmod(root, 0o700);
    const reportPath = join(root, 'evaluations', 'm4-18.json');
    const first = await reservePrivateReport(reportPath);
    await first.writeFile('first');
    await first.close();
    await expect(reservePrivateReport(reportPath)).rejects.toThrow();
    expect((await stat(reportPath)).mode & 0o777).toBe(0o600);
  });
});

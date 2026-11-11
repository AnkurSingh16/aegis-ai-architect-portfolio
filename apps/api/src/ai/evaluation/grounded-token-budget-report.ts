import type { EvaluationSourceIdentity } from './source-identity.js';
import type { BalancedRun } from './grounded-balanced-runner.js';
import { createGroundedBalancedReportV2 } from './grounded-balanced-report-v2.js';
import { groundedBalancedDatasetVersion } from './grounded-balanced-dataset.js';
import { groundedTokenBudget512EvaluationBranch } from './source-identity.js';

export const groundedTokenBudget512EvaluatorVersion = 'aegis-grounded-token-budget-512-v1' as const;
export const groundedTokenBudget512ReportSchemaVersion = 'aegis-grounded-token-budget-report-v1' as const;
export const groundedTokenBudget512ReportRelativePath = '.local/evaluations/milestone-4.15-grounded-token-budget-512-qwen2.5-3b-instruct-v1.json';

/** Versioned sanitized projection: no prompts, source text, case facts, rationales, or citation identifiers. */
export function createGroundedTokenBudget512Report(input: { source: EvaluationSourceIdentity; run: BalancedRun }) {
  const diagnostic = createGroundedBalancedReportV2({ source: input.source, model: 'qwen2.5:3b-instruct', run: input.run });
  const attempts = input.run.observations.map((observation) => {
    const attempt = diagnostic.attempts.find((item) => item.scenarioId === observation.scenarioId);
    return {
      ...attempt,
      expectedGroundingState: observation.expectedGroundingState,
      actualGroundingState: observation.groundingState,
      jsonParsed: observation.parsedJson,
      contractAccepted: observation.schemaAccepted,
      citationsValid: observation.citationsValid,
      expectedSourceCoverage: { numerator: observation.citedExpectedSourceIdentities.length,
        denominator: observation.expectedSourceIdentities.length },
      humanReviewEnforced: observation.humanReviewRequired,
    };
  });
  return {
    reportSchemaVersion: groundedTokenBudget512ReportSchemaVersion,
    evaluatorVersion: groundedTokenBudget512EvaluatorVersion,
    datasetVersion: groundedBalancedDatasetVersion,
    source: { ...input.source, reviewedBranch: `origin/${groundedTokenBudget512EvaluationBranch}` },
    model: 'qwen2.5:3b-instruct',
    generation: { numPredict: 512, temperature: 0.1, timeoutMs: 15000, maxConcurrent: 1,
      maxAttempts: 6, retryCount: 0 },
    plannedAttempts: 6,
    executionStatus: diagnostic.executionStatus,
    contractAcceptanceStatus: diagnostic.contractAcceptanceStatus,
    decisionQualityStatus: diagnostic.decisionQualityStatus,
    decisionQualityCriteria: diagnostic.decisionQualityCriteria,
    attempts,
    score: diagnostic.score,
    comparison: { baselineDatasetVersion: 'aegis-grounded-balanced-v1', method: 'same six scenarios against preserved 256-token historical runs',
      pairedWithinRun: false },
    limitations: [...diagnostic.limitations,
      'The comparison with earlier 256-token observations is historical and unpaired; it is descriptive, not a causal or statistical claim.',
      'The 512-token ceiling does not increase the existing 4096-byte model-output or 8192-byte envelope limits.'],
  };
}

import type { EvaluationSourceIdentity } from './source-identity.js';
import type { BalancedRun } from './grounded-balanced-runner.js';
import { createGroundedBalancedReportV2 } from './grounded-balanced-report-v2.js';
import { groundedBalancedDatasetVersion } from './grounded-balanced-dataset.js';
import { groundedConfidenceContractEvaluationBranch } from './source-identity.js';

export const groundedConfidenceContractEvaluatorVersion = 'aegis-grounded-confidence-contract-v1' as const;
export const groundedConfidenceContractReportSchemaVersion = 'aegis-grounded-confidence-contract-report-v1' as const;
export const groundedConfidenceContractPromptVariant = 'supported-confidence-type-range-calibration-disclaimer-v1' as const;
export const groundedConfidenceContractReportRelativePath =
  '.local/evaluations/milestone-4.17-grounded-confidence-contract-qwen2.5-3b-instruct-v1.json';

/** Sanitized, versioned report projection. It deliberately omits generated text, confidence values and source identifiers. */
export function createGroundedConfidenceContractReport(input: { source: EvaluationSourceIdentity; run: BalancedRun }) {
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
    reportSchemaVersion: groundedConfidenceContractReportSchemaVersion,
    evaluatorVersion: groundedConfidenceContractEvaluatorVersion,
    datasetVersion: groundedBalancedDatasetVersion,
    source: { ...input.source, reviewedBranch: `origin/${groundedConfidenceContractEvaluationBranch}` },
    model: 'qwen2.5:3b-instruct',
    promptVariant: groundedConfidenceContractPromptVariant,
    generation: { numPredict: 512, temperature: 0.1, timeoutMs: 15000, maxConcurrent: 1,
      maxAttempts: 6, retryCount: 0 },
    plannedAttempts: 6,
    executionStatus: diagnostic.executionStatus,
    contractAcceptanceStatus: diagnostic.contractAcceptanceStatus,
    decisionQualityStatus: 'not_rated' as const,
    decisionQualityCriteria: diagnostic.decisionQualityCriteria,
    attempts,
    score: diagnostic.score,
    limitations: [...diagnostic.limitations,
      'This is a one-variable confidence-contract prompt diagnostic. It does not establish improved model quality or statistically calibrated confidence.',
      'The six-case dataset is synthetic and engineering-reviewed; it is not production accuracy evidence.'],
  };
}

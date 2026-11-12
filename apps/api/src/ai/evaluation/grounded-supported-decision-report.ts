import type { BalancedAttempt, BalancedRun } from './grounded-balanced-runner.js';
import type { EvaluationSourceIdentity } from './source-identity.js';
import { createGroundedBalancedReportV2 } from './grounded-balanced-report-v2.js';
import { groundedBalancedDatasetVersion } from './grounded-balanced-dataset.js';
import { groundedSupportedDecisionEvaluationBranch } from './source-identity.js';

export const groundedSupportedDecisionEvaluatorVersion = 'aegis-grounded-supported-decision-v1' as const;
export const groundedSupportedDecisionReportSchemaVersion = 'aegis-grounded-supported-decision-report-v1' as const;
export const groundedSupportedDecisionPromptVariant = 'positive-complete-evidence-decision-boundary-v1' as const;
export const groundedSupportedDecisionReportRelativePath =
  '.local/evaluations/milestone-4.18-grounded-supported-decision-qwen2.5-3b-instruct-v1.json';

const comparisonMetrics = [
  'jsonParsing',
  'strictSchemaAcceptance',
  'supportedCoverage',
  'correctAbstentionAgreement',
  'incorrectAbstentions',
  'endToEndDecisionAgreement',
  'overallDecisionAgreement',
  'citationIdentityValidity',
  'expectedSourceCoverage',
  'humanReviewEnforcement',
  'generationCompletionReasons',
  'failureStagesAndValidationReasons',
] as const;

function pendingRun(run: BalancedRun): boolean {
  return run.attempts.some((attempt: BalancedAttempt) => attempt.status === 'not_attempted');
}

/** Sanitized report projection; it contains measurements, never prompts or source/case text. */
export function createGroundedSupportedDecisionReport(input: { source: EvaluationSourceIdentity; run: BalancedRun }) {
  const baseline = createGroundedBalancedReportV2({ source: input.source, model: 'qwen2.5:3b-instruct', run: input.run });
  return {
    ...baseline,
    reportSchemaVersion: groundedSupportedDecisionReportSchemaVersion,
    evaluatorVersion: groundedSupportedDecisionEvaluatorVersion,
    datasetVersion: groundedBalancedDatasetVersion,
    source: { ...input.source, reviewedBranch: `origin/${groundedSupportedDecisionEvaluationBranch}` },
    promptVariant: groundedSupportedDecisionPromptVariant,
    generation: { numPredict: 512, temperature: 0.1, timeoutMs: 15000, maxConcurrent: 1, maxAttempts: 6, retryCount: 0 },
    decisionQualityStatus: 'not_rated' as const,
    decisionQualityCriteria: {
      state: 'not_predeclared' as const,
      explanation: 'Report descriptive outcomes only; no decision-quality pass threshold was preregistered or independently approved.',
    },
    comparisonPlan: {
      primaryBaseline: {
        evaluator: 'M4.15',
        report: 'milestone-4.15-grounded-token-budget-512-qwen2.5-3b-instruct-v1.json',
        reason: 'M4.18 starts from the original M4.15 prompt and retains its model and generation settings.',
      },
      historicalContext: {
        evaluator: 'M4.17',
        report: 'milestone-4.17-grounded-confidence-contract-qwen2.5-3b-instruct-v1.json',
        reason: 'M4.17 used a separate confidence clarification and is reported as historical context, not a matched baseline.',
      },
      metrics: comparisonMetrics,
      pairedInputs: false,
      causalClaim: false,
    },
    plannedAttempts: 6,
    pendingSlots: pendingRun(input.run),
    limitations: [...baseline.limitations,
      'M4.18 is a single six-case synthetic diagnostic and cannot establish a causal effect or production accuracy.',
      'M4.15 is the primary descriptive baseline; M4.17 is historical context because it used a different prompt variant.',
      'Decision quality remains not_rated pending independent review and predeclared acceptance criteria.'],
  };
}

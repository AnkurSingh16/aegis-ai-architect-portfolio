import { evaluationCases, evaluationLabelStatus, type ExpectedCaseLabels } from './dataset.js';

export const groundedEvaluationDatasetVersion = 'aegis-grounded-provider-v1';
export const groundedEvaluationLabelStatus = evaluationLabelStatus;
const sourceByCase: Record<string, string> = {
  'SYNTHETIC-LOGIN-001': 'SYNTHETIC-NORTH-LOGIN-INCIDENT',
  'SYNTHETIC-BILLING-002': 'SYNTHETIC-SOUTH-BILLING-DISCREPANCY',
  'SYNTHETIC-GUIDANCE-003': 'SYNTHETIC-SOUTH-GENERAL-GUIDANCE',
};
export const groundedEvaluationSlots = evaluationCases.filter((item) => item.kind === 'canonical').flatMap((item) => [
  { slotId: `${item.id}-grounded-1`, caseType: item.caseType, expected: item.expected,
    expectedGroundingState: 'SUPPORTED' as const, expectedSourceIdentity: sourceByCase[item.caseType]! },
  { slotId: `${item.id}-grounded-2`, caseType: item.caseType, expected: item.expected,
    expectedGroundingState: 'SUPPORTED' as const, expectedSourceIdentity: sourceByCase[item.caseType]! },
]);

export type GroundedFailureStage = 'provider_connection' | 'provider_http' | 'response_size' | 'response_decode' |
  'response_envelope' | 'model_json_parse' | 'output_schema' | 'generation_timeout' | 'request_cancelled' | 'input_validation' | 'unknown';
export interface GroundedEvaluationObservation {
  slotId: string;
  caseType: string;
  expected: ExpectedCaseLabels;
  expectedGroundingState: 'SUPPORTED' | 'INSUFFICIENT_EVIDENCE';
  expectedSourceIdentity: string;
  status: 'success' | 'failure' | 'not_attempted';
  groundingState: 'SUPPORTED' | 'INSUFFICIENT_EVIDENCE' | null;
  parsedJson: boolean | null;
  schemaAccepted: boolean | null;
  citationsValid: boolean | null;
  evidenceCoverage: boolean | null;
  /** Requires an independent reviewer; null is reported as not measured. */
  groundednessReviewAgreement: boolean | null;
  humanReviewRequired: boolean | null;
  confidence: number | null;
  uncertainty: 'low' | 'moderate' | 'high' | null;
  result?: { category: string; priority: string; recommendedTeam: string; nextAction: string; humanReviewRequired: boolean };
  correlationComplete: boolean | null;
  failureStage?: GroundedFailureStage;
  latencyMs: number | null;
  promptTokens: number | null;
  generatedTokens: number | null;
}

export interface GroundedCountRate {
  numerator: number;
  denominator: number;
  rate: number | null;
  state: 'measured' | 'not_measured';
}
const rate = (numerator: number, denominator: number): GroundedCountRate => ({ numerator, denominator,
  rate: denominator === 0 ? null : Number((numerator / denominator).toFixed(4)), state: denominator ? 'measured' : 'not_measured' });
const median = (values: number[]): number | null => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : Math.round((sorted[middle - 1]! + sorted[middle]!) / 2);
};
const failureStages: readonly GroundedFailureStage[] = ['provider_connection', 'provider_http', 'response_size', 'response_decode',
  'response_envelope', 'model_json_parse', 'output_schema', 'generation_timeout', 'request_cancelled', 'input_validation', 'unknown'];

/** Pure scorer. It reports contract agreement, not semantic proof or production accuracy. */
export function scoreGroundedEvaluation(observations: readonly GroundedEvaluationObservation[]) {
  const attempted = observations.filter((item) => item.status !== 'not_attempted');
  const successful = attempted.filter((item) => item.status === 'success');
  const classified = successful.filter((item) => item.expectedGroundingState === 'SUPPORTED');
  const applicable = (key: 'parsedJson' | 'schemaAccepted' | 'citationsValid' | 'evidenceCoverage' | 'groundednessReviewAgreement' | 'correlationComplete') =>
    attempted.filter((item) => item[key] !== null);
  const booleanRate = (key: 'parsedJson' | 'schemaAccepted' | 'citationsValid' | 'evidenceCoverage' | 'groundednessReviewAgreement' | 'correlationComplete') => {
    const values = applicable(key);
    return rate(values.filter((item) => item[key] === true).length, values.length);
  };
  const fieldMatch = (field: keyof ExpectedCaseLabels, actual: keyof NonNullable<GroundedEvaluationObservation['result']>) =>
    rate(classified.filter((item) => item.result?.[actual] === item.expected[field]).length, classified.length);
  const groundingResults = successful.filter((item) => item.groundingState !== null);
  const countByCase = Object.fromEntries([...new Set(observations.map((item) => item.caseType))].sort().map((caseType) => {
    const rows = observations.filter((item) => item.caseType === caseType);
    return [caseType, { planned: rows.length, attempted: rows.filter((item) => item.status !== 'not_attempted').length,
      succeeded: rows.filter((item) => item.status === 'success').length, failed: rows.filter((item) => item.status === 'failure').length }];
  }));
  const latency = attempted.flatMap((item) => item.latencyMs === null ? [] : [item.latencyMs]);
  const promptTokens = attempted.flatMap((item) => item.promptTokens === null ? [] : [item.promptTokens]);
  const generatedTokens = attempted.flatMap((item) => item.generatedTokens === null ? [] : [item.generatedTokens]);
  const stages = Object.fromEntries(failureStages.map((stage) => [stage, attempted.filter((item) => item.status === 'failure' && item.failureStage === stage).length]));
  const successfulEvidence = successful.filter((item) => item.evidenceCoverage !== null);
  const reviewChecked = successful.filter((item) => item.humanReviewRequired !== null);
  return {
    datasetVersion: groundedEvaluationDatasetVersion,
    labelStatus: groundedEvaluationLabelStatus,
    planned: observations.length,
    attempted: attempted.length,
    succeeded: successful.length,
    failed: attempted.length - successful.length,
    notAttempted: observations.length - attempted.length,
    byCaseType: countByCase,
    metrics: {
      groundingStateAgreement: rate(groundingResults.filter((item) => item.groundingState === item.expectedGroundingState).length, groundingResults.length),
      groundingStates: { supported: groundingResults.filter((item) => item.groundingState === 'SUPPORTED').length,
        insufficientEvidence: groundingResults.filter((item) => item.groundingState === 'INSUFFICIENT_EVIDENCE').length,
        denominator: groundingResults.length },
      jsonParsing: booleanRate('parsedJson'),
      strictSchemaAcceptance: booleanRate('schemaAccepted'),
      citationValidity: booleanRate('citationsValid'),
      evidenceCoverage: rate(successfulEvidence.filter((item) => item.evidenceCoverage === true).length, successfulEvidence.length),
      groundednessReviewAgreement: booleanRate('groundednessReviewAgreement'),
      categoryAgreement: fieldMatch('category', 'category'),
      priorityAgreement: fieldMatch('priority', 'priority'),
      recommendedTeamAgreement: fieldMatch('recommendedTeam', 'recommendedTeam'),
      nextActionAgreement: fieldMatch('nextAction', 'nextAction'),
      humanReviewEnforcement: rate(reviewChecked.filter((item) => item.humanReviewRequired === true).length, reviewChecked.length),
      correlationCompleteness: booleanRate('correlationComplete'),
      failureStages: { counts: stages, denominator: attempted.filter((item) => item.status === 'failure').length },
      latencyMs: { samples: latency.length, median: median(latency), p95: null as number | null,
        p95State: latency.length < 20 ? 'not_measured_sample_too_small' as const : 'not_implemented' as const },
      tokenUsage: { promptSamples: promptTokens.length, generatedSamples: generatedTokens.length, promptTokens, generatedTokens },
      confidence: { meaning: 'model-reported-uncalibrated' as const,
        samples: attempted.filter((item) => item.confidence !== null).length,
        values: attempted.flatMap((item) => item.confidence === null ? [] : [item.confidence]) },
      uncertainty: { samples: attempted.filter((item) => item.uncertainty !== null).length,
        counts: { low: attempted.filter((item) => item.uncertainty === 'low').length,
          moderate: attempted.filter((item) => item.uncertainty === 'moderate').length,
          high: attempted.filter((item) => item.uncertainty === 'high').length } },
      authenticationAndTenantIsolation: { state: 'not_measured_by_provider_harness' as const,
        note: 'This fixed in-memory provider evaluation does not exercise Auth0, membership checks, HTTP correlation, or PostgreSQL RLS.' },
    },
  };
}

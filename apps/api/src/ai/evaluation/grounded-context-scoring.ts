import type { GroundedProviderOutput } from '../grounded-analysis.js';
import { groundedContextDatasetVersion, groundedContextLabelStatus, groundedContextSlots, type GroundedContextSlot } from './grounded-context-dataset.js';

export interface ContextObservation {
  slotId: string;
  caseId: string;
  expectedGroundingState: GroundedContextSlot['expectedGroundingState'];
  expected: GroundedContextSlot['expected'];
  status: 'success' | 'failure' | 'not_attempted';
  groundingState: GroundedProviderOutput['groundingState'] | null;
  parsedJson: boolean | null;
  schemaAccepted: boolean | null;
  citationsValid: boolean | null;
  sourceCoverage: boolean | null;
  humanReviewRequired: boolean | null;
  semanticGroundingReviewed: boolean | null;
  correlationComplete: boolean | null;
  category?: string;
  priority?: string;
  recommendedTeam?: string;
  nextAction?: string;
  failureStage?: string;
  latencyMs: number | null;
  promptTokens: number | null;
  generatedTokens: number | null;
}

export interface CountRate { numerator: number; denominator: number; rate: number | null; state: 'measured' | 'not_measured' }
const rate = (numerator: number, denominator: number): CountRate => ({ numerator, denominator,
  rate: denominator === 0 ? null : Number((numerator / denominator).toFixed(4)), state: denominator === 0 ? 'not_measured' : 'measured' });
const available = (items: readonly ContextObservation[], key: keyof ContextObservation) => items.filter((item) => item[key] !== null);

function applicableExpectedSupported(observation: ContextObservation): boolean {
  return observation.expectedGroundingState === 'SUPPORTED' && observation.expected !== null;
}

function labelsMatch(observation: ContextObservation): boolean {
  const expected = observation.expected;
  return expected !== null && expected.category !== undefined && expected.priority !== undefined &&
    expected.recommendedTeam !== undefined && expected.nextAction !== undefined && observation.category === expected.category &&
    observation.priority === expected.priority && observation.recommendedTeam === expected.recommendedTeam &&
    observation.nextAction === expected.nextAction;
}

/** Scorer for context-complete datasets. Denominators include all planned slots where abstentions/failures must count. */
export function scoreGroundedContextEvaluation(observations: readonly ContextObservation[]) {
  const expectedSupported = observations.filter(applicableExpectedSupported);
  const expectedInsufficient = observations.filter((item) => item.expectedGroundingState === 'INSUFFICIENT_EVIDENCE');
  const successful = observations.filter((item) => item.status === 'success');
  const actualSupported = successful.filter((item) => item.groundingState === 'SUPPORTED' && applicableExpectedSupported(item));
  const metric = (field: 'category' | 'priority' | 'recommendedTeam' | 'nextAction'): CountRate => {
    const withExpected = actualSupported.filter((item) => item.expected !== null && item.expected[field] !== undefined);
    return rate(withExpected.filter((item) => item[field] === item.expected?.[field]).length, withExpected.length);
  };
  const e2e = expectedSupported.filter((item) => item.expected?.category !== undefined && item.expected.priority !== undefined &&
    item.expected.recommendedTeam !== undefined && item.expected.nextAction !== undefined);
  const semantic = available(observations, 'semanticGroundingReviewed');
  const parsed = available(observations, 'parsedJson');
  const schema = available(observations, 'schemaAccepted');
  const citations = available(observations, 'citationsValid');
  const coverage = successful.filter((item) => item.groundingState === 'SUPPORTED' && item.sourceCoverage !== null);
  const review = successful.filter((item) => item.humanReviewRequired !== null);
  const correlation = available(observations, 'correlationComplete');
  const failureCount = observations.filter((item) => item.status === 'failure').length;
  const byCaseId = Object.fromEntries([...new Set(observations.map((item) => item.caseId))].sort().map((caseId) => {
    const rows = observations.filter((item) => item.caseId === caseId);
    return [caseId, { planned: rows.length, attempted: rows.filter((row) => row.status !== 'not_attempted').length,
      succeeded: rows.filter((row) => row.status === 'success').length, failed: rows.filter((row) => row.status === 'failure').length }];
  }));
  const latency = observations.flatMap((item) => item.latencyMs === null ? [] : [item.latencyMs]).sort((a, b) => a - b);
  const median = latency.length === 0 ? null : latency.length % 2 ? latency[Math.floor(latency.length / 2)]! :
    Math.round((latency[latency.length / 2 - 1]! + latency[latency.length / 2]!) / 2);

  return {
    datasetVersion: groundedContextDatasetVersion,
    labelStatus: groundedContextLabelStatus,
    planned: observations.length,
    attempted: observations.filter((item) => item.status !== 'not_attempted').length,
    succeeded: successful.length,
    failed: failureCount,
    notAttempted: observations.filter((item) => item.status === 'not_attempted').length,
    byCaseId,
    metrics: {
      jsonParsing: rate(parsed.filter((item) => item.parsedJson === true).length, parsed.length),
      strictSchemaAcceptance: rate(schema.filter((item) => item.schemaAccepted === true).length, schema.length),
      supportedResponseCoverage: rate(expectedSupported.filter((item) => item.status === 'success' && item.groundingState === 'SUPPORTED').length,
        expectedSupported.length),
      correctAbstentionAgreement: rate(expectedInsufficient.filter((item) => item.status === 'success' &&
        item.groundingState === 'INSUFFICIENT_EVIDENCE').length, expectedInsufficient.length),
      conditionalClassificationAccuracy: {
        category: metric('category'), priority: metric('priority'), recommendedTeam: metric('recommendedTeam'), nextAction: metric('nextAction'),
        denominatorDescription: 'Actual SUPPORTED outputs with an expected-supported label and an applicable expected field.',
      },
      endToEndExpectedSupportedAgreement: rate(e2e.filter((item) => item.status === 'success' && item.groundingState === 'SUPPORTED' && labelsMatch(item)).length,
        e2e.length),
      citationIdentityValidity: rate(citations.filter((item) => item.citationsValid === true).length, citations.length),
      sourceCoverage: rate(coverage.filter((item) => item.sourceCoverage === true).length, coverage.length),
      humanReviewEnforcement: rate(review.filter((item) => item.humanReviewRequired === true).length, review.length),
      semanticGroundingReview: rate(semantic.filter((item) => item.semanticGroundingReviewed === true).length, semantic.length),
      groundingStateAgreement: rate(successful.filter((item) => item.groundingState === item.expectedGroundingState).length, successful.length),
      correlationCompleteness: rate(correlation.filter((item) => item.correlationComplete === true).length, correlation.length),
      failureStages: { denominator: failureCount,
        counts: Object.fromEntries([...new Set(observations.map((item) => item.failureStage).filter((stage): stage is string => Boolean(stage)))].sort()
          .map((stage) => [stage, observations.filter((item) => item.status === 'failure' && item.failureStage === stage).length])) },
      latencyMs: { samples: latency.length, median, p95: null as number | null, p95State: latency.length < 20 ? 'not_measured_sample_too_small' : 'not_implemented' },
      tokenUsage: { promptSamples: observations.filter((item) => item.promptTokens !== null).length,
        generatedSamples: observations.filter((item) => item.generatedTokens !== null).length,
        promptTokens: observations.flatMap((item) => item.promptTokens === null ? [] : [item.promptTokens]),
        generatedTokens: observations.flatMap((item) => item.generatedTokens === null ? [] : [item.generatedTokens]) },
      authenticationAndTenantIsolation: { state: 'not_measured_by_provider_harness' as const },
    },
  };
}

export function createContextObservation(slot: GroundedContextSlot, status: ContextObservation['status'], changes: Partial<ContextObservation> = {}): ContextObservation {
  return { slotId: slot.slotId, caseId: slot.caseId, expectedGroundingState: slot.expectedGroundingState, expected: slot.expected,
    status, groundingState: null, parsedJson: null, schemaAccepted: null, citationsValid: null, sourceCoverage: null,
    humanReviewRequired: null, semanticGroundingReviewed: null, correlationComplete: null, latencyMs: null,
    promptTokens: null, generatedTokens: null, ...changes };
}

export const groundedContextPlannedSlotCount = groundedContextSlots.length;

import type { GroundedProviderOutput } from '../grounded-analysis.js';
import { groundedBalancedDatasetVersion, groundedBalancedLabelStatus, groundedBalancedScenarios, type GroundedBalancedScenario } from './grounded-balanced-dataset.js';
import type { GroundedProviderDiagnostics } from './grounded-provider-diagnostics.js';

export interface BalancedObservation {
  scenarioId: string;
  expectedGroundingState: GroundedBalancedScenario['expectedGroundingState'];
  expected: GroundedBalancedScenario['expected'];
  expectedSourceIdentities: readonly string[];
  status: 'success' | 'failure' | 'not_attempted';
  groundingState: GroundedProviderOutput['groundingState'] | null;
  parsedJson: boolean | null;
  schemaAccepted: boolean | null;
  citationsValid: boolean | null;
  citedExpectedSourceIdentities: string[];
  humanReviewRequired: boolean | null;
  correlationComplete: boolean | null;
  failureStage: string | null;
  validationReason: string | null;
  category?: string;
  priority?: string;
  recommendedTeam?: string;
  nextAction?: string;
  latencyMs: number | null;
  promptTokens: number | null;
  generatedTokens: number | null;
  providerDiagnostics: GroundedProviderDiagnostics | null;
}

export interface BalancedRate { numerator: number; denominator: number; rate: number | null; state: 'measured' | 'not_measured' }
const rate = (numerator: number, denominator: number): BalancedRate => ({ numerator, denominator,
  rate: denominator === 0 ? null : Number((numerator / denominator).toFixed(4)), state: denominator === 0 ? 'not_measured' : 'measured' });

function exactDecision(item: BalancedObservation): boolean {
  return item.expected !== null && item.groundingState === 'SUPPORTED' && item.category === item.expected.category &&
    item.priority === item.expected.priority && item.recommendedTeam === item.expected.recommendedTeam && item.nextAction === item.expected.nextAction;
}

/** Decision-quality denominators are fixed from the predeclared dataset, not model output. */
export function scoreGroundedBalancedEvaluation(observations: readonly BalancedObservation[]) {
  const attempted = observations.filter((item) => item.status !== 'not_attempted');
  const accepted = observations.filter((item) => item.status === 'success' && item.schemaAccepted === true);
  const expectedSupported = observations.filter((item) => item.expectedGroundingState === 'SUPPORTED' && item.expected !== null);
  const expectedInsufficient = observations.filter((item) => item.expectedGroundingState === 'INSUFFICIENT_EVIDENCE');
  const actualSupportedExpected = accepted.filter((item) => item.expectedGroundingState === 'SUPPORTED' && item.groundingState === 'SUPPORTED');
  const conditional = (key: 'category' | 'priority' | 'recommendedTeam' | 'nextAction'): BalancedRate => {
    const applicable = actualSupportedExpected.filter((item) => item.expected !== null && item.expected[key] !== undefined);
    return rate(applicable.filter((item) => item[key] === item.expected?.[key]).length, applicable.length);
  };
  const latencies = observations.flatMap((item) => item.latencyMs === null ? [] : [item.latencyMs]).sort((a, b) => a - b);
  const tokens = (field: 'promptTokens' | 'generatedTokens') => observations.flatMap((item) => item[field] === null ? [] : [item[field]!]);
  const failureStages = Object.fromEntries([...new Set(observations.map((item) => item.failureStage).filter((value): value is string => value !== null))]
    .sort().map((stage) => [stage, observations.filter((item) => item.status === 'failure' && item.failureStage === stage).length]));
  const reasons = Object.fromEntries([...new Set(observations.map((item) => item.validationReason).filter((value): value is string => value !== null))]
    .sort().map((reason) => [reason, observations.filter((item) => item.status === 'failure' && item.validationReason === reason).length]));
  const outputSupported = accepted.filter((item) => item.groundingState === 'SUPPORTED');
  const outputInsufficient = accepted.filter((item) => item.groundingState === 'INSUFFICIENT_EVIDENCE');
  const correctSupported = expectedSupported.filter((item) => item.status === 'success' && exactDecision(item));
  const correctAbstentions = expectedInsufficient.filter((item) => item.status === 'success' && item.groundingState === 'INSUFFICIENT_EVIDENCE');
  const wrongSupportedOnInsufficient = expectedInsufficient.filter((item) => item.status === 'success' && item.groundingState === 'SUPPORTED');
  const wrongLabels = actualSupportedExpected.filter((item) => !exactDecision(item));
  const countTrue = (key: 'parsedJson' | 'schemaAccepted' | 'citationsValid' | 'humanReviewRequired' | 'correlationComplete') => {
    const measured = observations.filter((item) => item[key] !== null);
    return rate(measured.filter((item) => item[key] === true).length, measured.length);
  };
  const citationMeasured = observations.filter((item) => item.citationsValid !== null);
  const citedRefs = observations.filter((item) => item.groundingState === 'SUPPORTED' && item.schemaAccepted === true)
    .reduce((sum, item) => sum + (item.citedExpectedSourceIdentities.length), 0);
  const totalExpectedRefs = expectedSupported.reduce((sum, item) => sum + item.expectedSourceIdentities.length, 0);

  return {
    datasetVersion: groundedBalancedDatasetVersion,
    labelStatus: groundedBalancedLabelStatus,
    planned: observations.length,
    attempted: attempted.length,
    succeeded: observations.filter((item) => item.status === 'success').length,
    failed: observations.filter((item) => item.status === 'failure').length,
    notAttempted: observations.filter((item) => item.status === 'not_attempted').length,
    populations: { supportedExpected: expectedSupported.length, insufficientExpected: expectedInsufficient.length,
      acceptedSupported: outputSupported.length, acceptedAbstentions: outputInsufficient.length },
    metrics: {
      jsonParsing: countTrue('parsedJson'),
      strictSchemaAcceptance: countTrue('schemaAccepted'),
      supportedCoverage: rate(expectedSupported.filter((item) => item.status === 'success' && item.groundingState === 'SUPPORTED').length, expectedSupported.length),
      correctAbstentionAgreement: rate(correctAbstentions.length, expectedInsufficient.length),
      incorrectAbstentions: rate(expectedSupported.filter((item) => item.status === 'success' && item.groundingState === 'INSUFFICIENT_EVIDENCE').length,
        expectedSupported.length),
      incorrectSupportedAnswers: { count: wrongSupportedOnInsufficient.length + wrongLabels.length,
        denominator: accepted.length, rate: accepted.length ? Number(((wrongSupportedOnInsufficient.length + wrongLabels.length) / accepted.length).toFixed(4)) : null,
        denominatorDescription: 'All accepted SUPPORTED or INSUFFICIENT_EVIDENCE decisions; provider failures are reported separately.',
        state: accepted.length ? 'measured' as const : 'not_measured' as const,
        components: { wrongLabelBundleAmongExpectedSupported: rate(wrongLabels.length, expectedSupported.length),
          unsupportedPredictionAmongExpectedInsufficient: rate(wrongSupportedOnInsufficient.length, expectedInsufficient.length) } },
      conditionalClassificationAccuracy: { category: conditional('category'), priority: conditional('priority'),
        recommendedTeam: conditional('recommendedTeam'), nextAction: conditional('nextAction'),
        denominator: 'Accepted SUPPORTED outputs among expected-supported cases with the corresponding predeclared label.' },
      endToEndDecisionAgreement: rate(correctSupported.length, expectedSupported.length),
      overallDecisionAgreement: rate(correctSupported.length + correctAbstentions.length, observations.length),
      citationIdentityValidity: rate(citationMeasured.filter((item) => item.citationsValid === true).length, citationMeasured.length),
      expectedSourceCoverage: rate(citedRefs, totalExpectedRefs),
      humanReviewEnforcement: countTrue('humanReviewRequired'),
      providerCorrelationCompleteness: countTrue('correlationComplete'),
      semanticGroundednessReview: { numerator: 0, denominator: 0, rate: null, state: 'not_measured' as const },
      failureStages: { denominator: observations.filter((item) => item.status === 'failure').length, counts: failureStages,
        validationReasons: reasons },
      latencyMs: { samples: latencies.length, values: latencies, median: latencies.length ? (latencies.length % 2 ? latencies[(latencies.length - 1) / 2]! :
        Math.round((latencies[latencies.length / 2 - 1]! + latencies[latencies.length / 2]!) / 2)) : null,
        p95: null, p95State: 'not_measured_sample_too_small' as const },
      tokenUsage: { promptSamples: tokens('promptTokens').length, promptTokens: tokens('promptTokens'),
        generatedSamples: tokens('generatedTokens').length, generatedTokens: tokens('generatedTokens') },
    },
  };
}

export function createBalancedObservation(scenario: GroundedBalancedScenario, status: BalancedObservation['status'],
  changes: Partial<BalancedObservation> = {}): BalancedObservation {
  return { scenarioId: scenario.scenarioId, expectedGroundingState: scenario.expectedGroundingState, expected: scenario.expected,
    expectedSourceIdentities: scenario.expectedSourceIdentities,
    status, groundingState: null, parsedJson: null, schemaAccepted: null, citationsValid: null, citedExpectedSourceIdentities: [],
    humanReviewRequired: null, correlationComplete: null, failureStage: null, validationReason: null,
    latencyMs: null, promptTokens: null, generatedTokens: null, providerDiagnostics: null, ...changes };
}

export const groundedBalancedScenarioCount = groundedBalancedScenarios.length;

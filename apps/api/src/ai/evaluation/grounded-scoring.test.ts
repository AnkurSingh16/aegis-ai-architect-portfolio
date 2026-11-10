import { describe, expect, it } from 'vitest';
import { groundedEvaluationSlots, scoreGroundedEvaluation, type GroundedEvaluationObservation } from './grounded-scoring.js';
import type { ExpectedCaseLabels } from './dataset.js';

const labels: ExpectedCaseLabels = { category: 'incident', priority: 'high', recommendedTeam: 'Platform support', nextAction: 'Review the synthetic service impact and incident timeline.' };
const billingLabels: ExpectedCaseLabels = { category: 'billing', priority: 'medium', recommendedTeam: 'Billing support',
  nextAction: 'Compare the synthetic invoice records before taking any billing action.' };
function observation(slotId: string, changes: Partial<GroundedEvaluationObservation> = {}): GroundedEvaluationObservation {
  return { slotId, caseType: 'SYNTHETIC-LOGIN-001', expected: labels, expectedGroundingState: 'SUPPORTED',
    expectedSourceIdentity: 'SYNTHETIC-NORTH-LOGIN-INCIDENT', status: 'success', groundingState: 'SUPPORTED', parsedJson: true, schemaAccepted: true,
    citationsValid: true, evidenceCoverage: true, groundednessReviewAgreement: null,
    humanReviewRequired: true,
    confidence: 0.7, uncertainty: 'moderate',
    result: { ...labels, humanReviewRequired: true }, correlationComplete: true, latencyMs: 120, promptTokens: 40,
    generatedTokens: 18, ...changes };
}

describe('grounded evaluation scorer', () => {
  it('predeclares six provider slots across the three synthetic case types', () => {
    expect(groundedEvaluationSlots).toHaveLength(6);
    expect(new Set(groundedEvaluationSlots.map((slot) => slot.caseType))).toEqual(new Set([
      'SYNTHETIC-LOGIN-001', 'SYNTHETIC-BILLING-002', 'SYNTHETIC-GUIDANCE-003',
    ]));
    expect(groundedEvaluationSlots.map((slot) => slot.expected.priority)).toEqual(['high', 'high', 'medium', 'medium', 'low', 'low']);
  });

  it('reports each metric denominator separately and leaves unavailable review metrics unmeasured', () => {
    const score = scoreGroundedEvaluation([
      observation('one'),
      observation('two', { caseType: 'SYNTHETIC-BILLING-002', expected: billingLabels,
        result: { category: 'billing', priority: 'low', recommendedTeam: 'Billing support', nextAction: billingLabels.nextAction, humanReviewRequired: true },
        groundednessReviewAgreement: false, latencyMs: 240, promptTokens: null, generatedTokens: 20 }),
      observation('three', { status: 'failure', groundingState: null, parsedJson: true, schemaAccepted: false, citationsValid: null, evidenceCoverage: null,
        humanReviewRequired: null, confidence: null, uncertainty: null, result: undefined, correlationComplete: true,
        failureStage: 'output_schema', latencyMs: 300, promptTokens: null, generatedTokens: null }),
      observation('four', { status: 'not_attempted', groundingState: null, parsedJson: null, schemaAccepted: null, citationsValid: null, evidenceCoverage: null,
        groundednessReviewAgreement: null, humanReviewRequired: null, confidence: null, uncertainty: null, result: undefined,
        correlationComplete: null, latencyMs: null, promptTokens: null, generatedTokens: null }),
    ]);
    expect(score.attempted).toBe(3);
    expect(score.metrics.jsonParsing).toEqual({ numerator: 3, denominator: 3, rate: 1, state: 'measured' });
    expect(score.metrics.strictSchemaAcceptance).toEqual({ numerator: 2, denominator: 3, rate: 0.6667, state: 'measured' });
    expect(score.metrics.citationValidity.denominator).toBe(2);
    expect(score.metrics.groundednessReviewAgreement).toEqual({ numerator: 0, denominator: 1, rate: 0, state: 'measured' });
    expect(score.metrics.priorityAgreement).toMatchObject({ numerator: 1, denominator: 2, rate: 0.5 });
    expect(score.metrics.humanReviewEnforcement).toEqual({ numerator: 2, denominator: 2, rate: 1, state: 'measured' });
    expect(score.metrics.groundingStateAgreement).toEqual({ numerator: 2, denominator: 2, rate: 1, state: 'measured' });
    expect(score.metrics.groundingStates).toEqual({ supported: 2, insufficientEvidence: 0, denominator: 2 });
    expect(score.metrics.failureStages).toMatchObject({ denominator: 1, counts: { output_schema: 1 } });
    expect(score.metrics.latencyMs).toMatchObject({ samples: 3, median: 240, p95: null, p95State: 'not_measured_sample_too_small' });
    expect(score.metrics.tokenUsage).toMatchObject({ promptSamples: 1, generatedSamples: 2 });
    expect(score.metrics.confidence).toEqual({ meaning: 'model-reported-uncalibrated', samples: 2, values: [0.7, 0.7] });
    expect(score.metrics.uncertainty.counts).toEqual({ low: 0, moderate: 2, high: 0 });
    expect(score.metrics.authenticationAndTenantIsolation.state).toBe('not_measured_by_provider_harness');
  });

  it('does not convert unavailable measurements into zero-percent passes', () => {
    const score = scoreGroundedEvaluation([observation('unattempted', { status: 'not_attempted', groundingState: null, parsedJson: null, schemaAccepted: null,
      citationsValid: null, evidenceCoverage: null, groundednessReviewAgreement: null, result: undefined,
      humanReviewRequired: null, confidence: null, uncertainty: null, correlationComplete: null, latencyMs: null, promptTokens: null, generatedTokens: null })]);
    expect(score.metrics.jsonParsing).toEqual({ numerator: 0, denominator: 0, rate: null, state: 'not_measured' });
    expect(score.metrics.categoryAgreement).toEqual({ numerator: 0, denominator: 0, rate: null, state: 'not_measured' });
    expect(score.metrics.groundednessReviewAgreement.state).toBe('not_measured');
  });

  it('counts a validated abstention separately and scores its predeclared grounding state', () => {
    const abstention = observation('abstention', { groundingState: 'INSUFFICIENT_EVIDENCE', expectedGroundingState: 'SUPPORTED',
      result: undefined, evidenceCoverage: false, confidence: null, uncertainty: 'high' });
    const score = scoreGroundedEvaluation([abstention]);
    expect(score.succeeded).toBe(1);
    expect(score.metrics.groundingStates).toEqual({ supported: 0, insufficientEvidence: 1, denominator: 1 });
    expect(score.metrics.groundingStateAgreement).toEqual({ numerator: 0, denominator: 1, rate: 0, state: 'measured' });
    expect(score.metrics.categoryAgreement).toEqual({ numerator: 0, denominator: 1, rate: 0, state: 'measured' });
  });
});

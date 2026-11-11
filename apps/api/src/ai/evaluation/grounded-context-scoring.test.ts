import { describe, expect, it } from 'vitest';
import { groundedContextSlots, type GroundedContextSlot } from './grounded-context-dataset.js';
import { createContextObservation, scoreGroundedContextEvaluation } from './grounded-context-scoring.js';

const expected = { category: 'incident', priority: 'high', recommendedTeam: 'Platform support' as const,
  nextAction: 'Review the synthetic service impact and incident timeline.' as const } as const;
const supportedSlot: GroundedContextSlot = { ...groundedContextSlots[0]!, expectedGroundingState: 'SUPPORTED', expected };

describe('context evaluation scorer denominators', () => {
  it('scores abstention coverage, correct abstention, and end-to-end misses separately', () => {
    const incorrectAbstention = createContextObservation(supportedSlot, 'success', { groundingState: 'INSUFFICIENT_EVIDENCE',
      parsedJson: true, schemaAccepted: true, citationsValid: true, sourceCoverage: false, humanReviewRequired: true,
      correlationComplete: true });
    const correctAbstention = createContextObservation(groundedContextSlots[1]!, 'success', { groundingState: 'INSUFFICIENT_EVIDENCE',
      parsedJson: true, schemaAccepted: true, citationsValid: true, sourceCoverage: false, humanReviewRequired: true, correlationComplete: true });
    const score = scoreGroundedContextEvaluation([incorrectAbstention, correctAbstention]);
    expect(score.metrics.supportedResponseCoverage).toEqual({ numerator: 0, denominator: 1, rate: 0, state: 'measured' });
    expect(score.metrics.correctAbstentionAgreement).toEqual({ numerator: 1, denominator: 1, rate: 1, state: 'measured' });
    expect(score.metrics.endToEndExpectedSupportedAgreement).toEqual({ numerator: 0, denominator: 1, rate: 0, state: 'measured' });
    expect(score.metrics.conditionalClassificationAccuracy.priority).toEqual({ numerator: 0, denominator: 0, rate: null, state: 'not_measured' });
  });

  it('computes conditional field rates only from actual supported outputs with reviewed expected fields', () => {
    const supported = createContextObservation(supportedSlot, 'success', { groundingState: 'SUPPORTED', parsedJson: true,
      schemaAccepted: true, citationsValid: true, sourceCoverage: true, humanReviewRequired: true, correlationComplete: true,
      category: 'incident', priority: 'medium', recommendedTeam: 'Platform support', nextAction: expected.nextAction });
    const failed = createContextObservation(supportedSlot, 'failure', { parsedJson: false, schemaAccepted: false, failureStage: 'model_json_parse' });
    const score = scoreGroundedContextEvaluation([supported, failed]);
    expect(score.metrics.conditionalClassificationAccuracy.category).toMatchObject({ numerator: 1, denominator: 1, rate: 1 });
    expect(score.metrics.conditionalClassificationAccuracy.priority).toMatchObject({ numerator: 0, denominator: 1, rate: 0 });
    expect(score.metrics.endToEndExpectedSupportedAgreement).toMatchObject({ numerator: 0, denominator: 2, rate: 0 });
    expect(score.metrics.citationIdentityValidity).toMatchObject({ numerator: 1, denominator: 1 });
  });

  it('counts a missing supported field as a mismatch rather than excluding it', () => {
    const incomplete = createContextObservation(supportedSlot, 'success', { groundingState: 'SUPPORTED', parsedJson: true,
      schemaAccepted: true, citationsValid: true, sourceCoverage: true, humanReviewRequired: true, correlationComplete: true,
      category: 'incident', priority: undefined, recommendedTeam: 'Platform support', nextAction: expected.nextAction });
    const score = scoreGroundedContextEvaluation([incomplete]);
    expect(score.metrics.conditionalClassificationAccuracy.priority)
      .toEqual({ numerator: 0, denominator: 1, rate: 0, state: 'measured' });
    expect(score.metrics.endToEndExpectedSupportedAgreement)
      .toEqual({ numerator: 0, denominator: 1, rate: 0, state: 'measured' });
  });

  it('reports zero-denominator metrics as not measured, not as a pass', () => {
    const score = scoreGroundedContextEvaluation(groundedContextSlots.map((slot) => createContextObservation(slot, 'not_attempted')));
    expect(score.metrics.supportedResponseCoverage).toEqual({ numerator: 0, denominator: 0, rate: null, state: 'not_measured' });
    expect(score.metrics.conditionalClassificationAccuracy.category.state).toBe('not_measured');
    expect(score.metrics.semanticGroundingReview.state).toBe('not_measured');
  });

  it('does not count an abstention as source coverage', () => {
    const abstention = createContextObservation(groundedContextSlots[0]!, 'success', { groundingState: 'INSUFFICIENT_EVIDENCE',
      parsedJson: true, schemaAccepted: true, citationsValid: true, sourceCoverage: false, humanReviewRequired: true, correlationComplete: true });
    expect(scoreGroundedContextEvaluation([abstention]).metrics.sourceCoverage)
      .toEqual({ numerator: 0, denominator: 0, rate: null, state: 'not_measured' });
  });
});

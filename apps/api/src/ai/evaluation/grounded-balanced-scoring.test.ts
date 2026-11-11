import { describe, expect, it } from 'vitest';
import { groundedBalancedScenarios } from './grounded-balanced-dataset.js';
import { createBalancedObservation, scoreGroundedBalancedEvaluation } from './grounded-balanced-scoring.js';

function accepted(scenario: typeof groundedBalancedScenarios[number]) {
  return createBalancedObservation(scenario, 'success', {
    groundingState: scenario.expectedGroundingState, parsedJson: true, schemaAccepted: true,
    citationsValid: scenario.expectedGroundingState === 'SUPPORTED' ? true : null,
    citedExpectedSourceIdentities: scenario.expectedGroundingState === 'SUPPORTED' ? [...scenario.expectedSourceIdentities] : [],
    humanReviewRequired: true, correlationComplete: true, latencyMs: 100, promptTokens: 20, generatedTokens: 30,
    ...(scenario.expected ? { category: scenario.expected.category, priority: scenario.expected.priority,
      recommendedTeam: scenario.expected.recommendedTeam, nextAction: scenario.expected.nextAction } : {}),
  });
}

describe('balanced grounded quality metric denominators', () => {
  it('separates supported coverage and correct abstention and measures fields only conditionally', () => {
    const score = scoreGroundedBalancedEvaluation(groundedBalancedScenarios.map(accepted));
    expect(score.metrics.supportedCoverage).toEqual({ numerator: 3, denominator: 3, rate: 1, state: 'measured' });
    expect(score.metrics.correctAbstentionAgreement).toEqual({ numerator: 3, denominator: 3, rate: 1, state: 'measured' });
    expect(score.metrics.incorrectAbstentions).toEqual({ numerator: 0, denominator: 3, rate: 0, state: 'measured' });
    expect(score.metrics.conditionalClassificationAccuracy.category).toMatchObject({ numerator: 3, denominator: 3, rate: 1 });
    expect(score.metrics.conditionalClassificationAccuracy.priority).toMatchObject({ numerator: 3, denominator: 3, rate: 1 });
    expect(score.metrics.conditionalClassificationAccuracy.recommendedTeam).toMatchObject({ numerator: 3, denominator: 3, rate: 1 });
    expect(score.metrics.conditionalClassificationAccuracy.nextAction).toMatchObject({ numerator: 3, denominator: 3, rate: 1 });
    expect(score.metrics.endToEndDecisionAgreement).toEqual({ numerator: 3, denominator: 3, rate: 1, state: 'measured' });
    expect(score.metrics.overallDecisionAgreement).toEqual({ numerator: 6, denominator: 6, rate: 1, state: 'measured' });
    expect(score.metrics.expectedSourceCoverage).toEqual({ numerator: 7, denominator: 7, rate: 1, state: 'measured' });
    expect(score.metrics.semanticGroundednessReview).toEqual({ numerator: 0, denominator: 0, rate: null, state: 'not_measured' });
  });

  it('counts abstentions and incorrect supported classifications as end-to-end misses', () => {
    const rows = groundedBalancedScenarios.map((scenario, index) => {
      if (index === 0) return createBalancedObservation(scenario, 'success', { groundingState: 'INSUFFICIENT_EVIDENCE',
        parsedJson: true, schemaAccepted: true, citationsValid: true, humanReviewRequired: true, correlationComplete: true });
      if (index === 2) return createBalancedObservation(scenario, 'success', { groundingState: 'SUPPORTED', parsedJson: true,
        schemaAccepted: true, citationsValid: true, citedExpectedSourceIdentities: [...scenario.expectedSourceIdentities],
        humanReviewRequired: true, correlationComplete: true, category: scenario.expected?.category, priority: 'low',
        recommendedTeam: scenario.expected?.recommendedTeam, nextAction: scenario.expected?.nextAction });
      return accepted(scenario);
    });
    const score = scoreGroundedBalancedEvaluation(rows);
    expect(score.metrics.incorrectAbstentions).toMatchObject({ numerator: 1, denominator: 3, rate: 0.3333 });
    expect(score.metrics.conditionalClassificationAccuracy.priority).toMatchObject({ numerator: 1, denominator: 2, rate: 0.5 });
    expect(score.metrics.endToEndDecisionAgreement).toMatchObject({ numerator: 1, denominator: 3, rate: 0.3333 });
    expect(score.metrics.incorrectSupportedAnswers.count).toBe(1);
    expect(score.metrics.incorrectSupportedAnswers.denominator).toBe(6);
  });

  it('counts supported predictions on expected-abstention cases as wrong and never scores absent labels as correct', () => {
    const rows = groundedBalancedScenarios.map((scenario, index) => {
      if (index !== 1) return accepted(scenario);
      return createBalancedObservation(scenario, 'success', { groundingState: 'SUPPORTED', parsedJson: true, schemaAccepted: true,
        citationsValid: true, humanReviewRequired: true, correlationComplete: true, category: 'incident', priority: 'low',
        recommendedTeam: 'Customer support', nextAction: 'Review the synthetic service impact and incident timeline.' });
    });
    const score = scoreGroundedBalancedEvaluation(rows);
    expect(score.metrics.incorrectSupportedAnswers.components.unsupportedPredictionAmongExpectedInsufficient)
      .toMatchObject({ numerator: 1, denominator: 3, rate: 0.3333 });
    expect(score.metrics.correctAbstentionAgreement).toMatchObject({ numerator: 2, denominator: 3, rate: 0.6667 });
    expect(score.metrics.conditionalClassificationAccuracy.category.denominator).toBe(3);
  });

  it('reports unavailable measurements as not measured instead of passing them', () => {
    const score = scoreGroundedBalancedEvaluation(groundedBalancedScenarios.map((scenario) => createBalancedObservation(scenario, 'not_attempted')));
    expect(score.metrics.jsonParsing.state).toBe('not_measured');
    expect(score.metrics.strictSchemaAcceptance.state).toBe('not_measured');
    expect(score.metrics.conditionalClassificationAccuracy.category.state).toBe('not_measured');
    expect(score.metrics.citationIdentityValidity.state).toBe('not_measured');
    expect(score.metrics.latencyMs.median).toBeNull();
  });
});

import type { EvaluationSourceIdentity } from './source-identity.js';
import type { BalancedAttempt, BalancedRun } from './grounded-balanced-runner.js';
import type { GroundedProviderDiagnostics } from './grounded-provider-diagnostics.js';
import { groundedBalancedDatasetVersion, groundedBalancedScenarios } from './grounded-balanced-dataset.js';
import { scoreGroundedBalancedEvaluation } from './grounded-balanced-scoring.js';

export const groundedBalancedReportV2SchemaVersion = 'aegis-grounded-balanced-report-v2' as const;
export const groundedBalancedReportV2RelativePath = '.local/evaluations/milestone-4.14-grounded-reliability-qwen2.5-3b-instruct-v1.json';
export const groundedBalancedDecisionQualityStatus = 'not_rated' as const;

export interface GroundedBalancedReportV2Attempt {
  scenarioId: string;
  status: BalancedAttempt['status'];
  groundingState: BalancedAttempt['groundingState'] | null;
  category: string | null;
  priority: string | null;
  recommendedTeam: string | null;
  nextAction: string | null;
  citationCount: number | null;
  humanReviewRequired: boolean | null;
  diagnostics: GroundedProviderDiagnostics;
}

/** Versioned sanitized report projection; it never accepts prompt, content, rationale, citations, or provider envelopes. */
export function createGroundedBalancedReportV2(input: {
  source: EvaluationSourceIdentity;
  model: 'qwen2.5:3b-instruct';
  run: BalancedRun;
}) {
  const score = scoreGroundedBalancedEvaluation(input.run.observations);
  const anyExplicitContractFailure = input.run.observations.some((item) => item.parsedJson === false || item.schemaAccepted === false);
  const expectedIds = groundedBalancedScenarios.map((scenario) => scenario.scenarioId);
  const observedIds = input.run.observations.map((item) => item.scenarioId);
  const attemptedIds = input.run.attempts.map((item) => item.scenarioId);
  const observedEveryScenarioOnce = observedIds.length === expectedIds.length && new Set(observedIds).size === expectedIds.length &&
    expectedIds.every((scenarioId) => observedIds.includes(scenarioId));
  const attemptedEveryScenarioOnce = attemptedIds.length === expectedIds.length && new Set(attemptedIds).size === expectedIds.length &&
    expectedIds.every((scenarioId) => attemptedIds.includes(scenarioId));
  const allSlotsComplete = observedEveryScenarioOnce && attemptedEveryScenarioOnce && score.notAttempted === 0 &&
    input.run.attempts.every((attempt) => attempt.status !== 'not_attempted');
  const allAccepted = allSlotsComplete && input.run.observations.every((item) => item.status === 'success' && item.schemaAccepted === true);
  const executionStatus = allSlotsComplete ? 'completed' as const : 'incomplete' as const;
  const contractAcceptanceStatus = anyExplicitContractFailure ? 'failed' as const : allAccepted ? 'passed' as const : 'incomplete' as const;
  const attempts: GroundedBalancedReportV2Attempt[] = input.run.attempts.map((attempt) => ({
    scenarioId: attempt.scenarioId,
    status: attempt.status,
    groundingState: attempt.groundingState ?? null,
    category: attempt.category ?? null,
    priority: attempt.priority ?? null,
    recommendedTeam: attempt.recommendedTeam ?? null,
    nextAction: attempt.nextAction ?? null,
    citationCount: attempt.citationCount ?? null,
    humanReviewRequired: attempt.humanReviewRequired ?? null,
    diagnostics: input.run.observations.find((item) => item.scenarioId === attempt.scenarioId)?.providerDiagnostics ?? {
      failureStage: null, validationReason: null, envelopeBytes: null, modelOutputBytes: null, promptTokens: null,
      generatedTokens: null, completionReason: null, outputLimitReached: null, latencyMs: attempt.latencyMs,
      correlationComplete: attempt.correlationComplete,
    },
  }));
  return {
    reportSchemaVersion: groundedBalancedReportV2SchemaVersion,
    datasetVersion: groundedBalancedDatasetVersion,
    model: input.model,
    source: input.source,
    plannedAttempts: 6,
    executionStatus,
    contractAcceptanceStatus,
    decisionQualityStatus: groundedBalancedDecisionQualityStatus,
    decisionQualityCriteria: { state: 'not_predeclared' as const,
      explanation: 'No aggregate decision-quality pass threshold was preregistered; report observed metrics without a pass/fail claim.' },
    attempts,
    score,
    limitations: ['Decision quality is not rated without criteria preregistered before evaluation.',
      'Citation identity and expected-source coverage do not prove semantic entailment.',
      'Provider-level execution does not validate authenticated HTTP, Auth0, membership, or RLS behavior.'],
  };
}

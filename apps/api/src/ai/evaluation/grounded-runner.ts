import { randomUUID } from 'node:crypto';
import { groundedValidationReasons, parseGroundedProviderOutput, type GroundedAnalysisProvider, type GroundedSource,
  type GroundedValidationReason } from '../grounded-analysis.js';
import { groundedEvaluationSlots, type GroundedEvaluationObservation, type GroundedFailureStage } from './grounded-scoring.js';
import type { SafeProviderEvent } from './grounded-provider-diagnostics.js';

type ProviderFactory = (log: (event: SafeProviderEvent) => void) => GroundedAnalysisProvider;
export interface GroundedEvaluationAttempt {
  attemptId?: string;
  slotId: string;
  caseType: string;
  status: 'success' | 'failure' | 'not_attempted';
  groundingState?: 'SUPPORTED' | 'INSUFFICIENT_EVIDENCE';
  category?: string;
  priority?: string;
  recommendedTeam?: string;
  nextAction?: string;
  confidence?: number | null;
  uncertainty?: 'low' | 'moderate' | 'high';
  citationCount?: number;
  humanReviewRequired?: true;
  failureStage?: GroundedFailureStage;
  schemaReason?: 'invalid_output' | 'invalid_citations';
  validationReason?: GroundedValidationReason;
  latencyMs?: number | null;
  promptTokens?: number | null;
  generatedTokens?: number | null;
  correlationComplete: boolean;
}
export interface GroundedEvaluationRun {
  observations: GroundedEvaluationObservation[];
  attempts: GroundedEvaluationAttempt[];
  stopped: boolean;
}

/** A completed evaluation means every planned slot reached an outcome, even if all outputs failed validation. */
export function groundedEvaluationCliResult(run: GroundedEvaluationRun, notAttempted: number): {
  status: 'completed' | 'stopped'; exitCode: 0 | 1;
} {
  const status = run.stopped || notAttempted > 0 ? 'stopped' : 'completed';
  return { status, exitCode: status === 'completed' ? 0 : 1 };
}

const stages: readonly GroundedFailureStage[] = ['provider_connection', 'provider_http', 'response_size', 'response_decode',
  'response_envelope', 'model_json_parse', 'output_schema', 'generation_timeout', 'request_cancelled', 'input_validation', 'unknown'];
function safeStage(value: unknown): GroundedFailureStage {
  return typeof value === 'string' && stages.includes(value as GroundedFailureStage) ? value as GroundedFailureStage : 'unknown';
}
function safeMetric(value: unknown): number | null {
  return Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : null;
}
function safeReason(value: unknown): 'invalid_output' | 'invalid_citations' | undefined {
  return value === 'invalid_output' || value === 'invalid_citations' ? value : undefined;
}
function safeValidationReason(value: unknown): GroundedValidationReason | undefined {
  return typeof value === 'string' && groundedValidationReasons.includes(value as GroundedValidationReason)
    ? value as GroundedValidationReason : undefined;
}
function emptyObservation(slot: typeof groundedEvaluationSlots[number], status: 'failure' | 'not_attempted',
  stage?: GroundedFailureStage, correlationComplete: boolean | null = false): GroundedEvaluationObservation {
  return { slotId: slot.slotId, caseType: slot.caseType, expected: slot.expected, expectedGroundingState: slot.expectedGroundingState,
    expectedSourceIdentity: slot.expectedSourceIdentity,
    status, groundingState: null, parsedJson: null, schemaAccepted: null, citationsValid: null, evidenceCoverage: null,
    groundednessReviewAgreement: null, humanReviewRequired: null, confidence: null, uncertainty: null,
    correlationComplete, ...(stage ? { failureStage: stage } : {}), latencyMs: null, promptTokens: null, generatedTokens: null };
}
function attemptFromFailure(slot: typeof groundedEvaluationSlots[number], attemptId: string, event: SafeProviderEvent | undefined,
  correlated: boolean): { attempt: GroundedEvaluationAttempt; observation: GroundedEvaluationObservation } {
  const failureStage = safeStage(event?.failureStage);
  const parsedJson = failureStage === 'output_schema' ? true : failureStage === 'model_json_parse' ? false : null;
  const schemaAccepted = failureStage === 'output_schema' ? false : null;
  const schemaReason = safeReason(event?.schemaReason);
  const validationReason = safeValidationReason(event?.validationReason);
  const citationsValid = schemaReason === 'invalid_citations' ? false : null;
  const observation = { ...emptyObservation(slot, 'failure', failureStage, correlated), parsedJson, schemaAccepted, citationsValid,
    ...(validationReason ? { validationReason } : {}),
    latencyMs: safeMetric(event?.latencyMs) };
  return { observation, attempt: { attemptId, slotId: slot.slotId, caseType: slot.caseType, status: 'failure', failureStage,
    ...(schemaReason ? { schemaReason } : {}), ...(validationReason ? { validationReason } : {}),
    latencyMs: observation.latencyMs, correlationComplete: correlated } };
}

/** Runs only the fixed six provider slots. One call per slot, no retries and no HTTP/database access. */
export async function runGroundedProviderEvaluation(options: {
  providerFactory: ProviderFactory;
  healthCheck: () => Promise<boolean>;
  sourcesFor: (caseType: string) => readonly GroundedSource[];
  onProgress?: (attempts: readonly GroundedEvaluationAttempt[], observations: readonly GroundedEvaluationObservation[]) => Promise<void>;
}): Promise<GroundedEvaluationRun> {
  if (groundedEvaluationSlots.length !== 6 || new Set(groundedEvaluationSlots.map((slot) => slot.slotId)).size !== 6) {
    throw new Error('Grounded evaluation plan does not match the fixed six-slot contract.');
  }
  const attempts: GroundedEvaluationAttempt[] = [];
  const observations: GroundedEvaluationObservation[] = [];
  let stopped = false;
  let initiallyHealthy = false;
  try { initiallyHealthy = await options.healthCheck(); } catch { initiallyHealthy = false; }
  if (!initiallyHealthy) {
    stopped = true;
    for (const slot of groundedEvaluationSlots) {
      attempts.push({ slotId: slot.slotId, caseType: slot.caseType, status: 'not_attempted', correlationComplete: false });
      observations.push(emptyObservation(slot, 'not_attempted', undefined, null));
    }
    await options.onProgress?.(attempts, observations);
    return { observations, attempts, stopped };
  }
  for (const slot of groundedEvaluationSlots) {
    const attemptId = randomUUID();
    const events: SafeProviderEvent[] = [];
    let observation: GroundedEvaluationObservation;
    let attempt: GroundedEvaluationAttempt;
    let providerFailureStage: GroundedFailureStage = 'unknown';
    let providerCalled = false;
    try {
      if (!await options.healthCheck()) throw new Error('health');
      const sources = options.sourcesFor(slot.caseType);
      const provider = options.providerFactory((event) => events.push(event));
      providerCalled = true;
      const response = await provider.analyze({ caseStatus: 'in_progress', caseType: slot.caseType, sources }, new AbortController().signal, attemptId);
      const output = parseGroundedProviderOutput(response.output, sources);
      const event = events.length === 1 ? events[0] : undefined;
      const correlationComplete = event?.event === 'ai_grounded_analysis' && event.outcome === 'success' && event.correlationId === attemptId;
      if (!correlationComplete) throw new Error('diagnostic');
      const supported = output.groundingState === 'SUPPORTED';
      const selectedSourceIds = new Set(sources.filter((source) => supported && output.citations.includes(source.citationId))
        .map((source) => source.sourceIdentity));
      const evidenceCoverage = supported && selectedSourceIds.has(slot.expectedSourceIdentity);
      observation = { slotId: slot.slotId, caseType: slot.caseType, expected: slot.expected,
        expectedGroundingState: slot.expectedGroundingState, expectedSourceIdentity: slot.expectedSourceIdentity,
        status: 'success', groundingState: output.groundingState,
        parsedJson: true, schemaAccepted: true, citationsValid: true, evidenceCoverage, groundednessReviewAgreement: null,
        humanReviewRequired: output.humanReviewRequired, confidence: supported ? output.confidence : null,
        uncertainty: output.uncertainty, ...(supported ? { result: { category: output.category, priority: output.priority,
          recommendedTeam: output.recommendedTeam, nextAction: output.nextAction, humanReviewRequired: output.humanReviewRequired } } : {}),
        correlationComplete: true, latencyMs: response.metrics.latencyMs, promptTokens: response.metrics.promptTokens,
        generatedTokens: response.metrics.generatedTokens };
      attempt = { attemptId, slotId: slot.slotId, caseType: slot.caseType, status: 'success', groundingState: output.groundingState,
        ...(supported ? { category: output.category, priority: output.priority, recommendedTeam: output.recommendedTeam,
          nextAction: output.nextAction, confidence: output.confidence, uncertainty: output.uncertainty } : {}),
        citationCount: output.citations.length, humanReviewRequired: true, latencyMs: response.metrics.latencyMs,
        promptTokens: response.metrics.promptTokens, generatedTokens: response.metrics.generatedTokens, correlationComplete: true };
    } catch {
      if (!providerCalled) {
        attempts.push({ slotId: slot.slotId, caseType: slot.caseType, status: 'not_attempted', correlationComplete: false });
        observations.push(emptyObservation(slot, 'not_attempted', undefined, null));
        stopped = true;
        await options.onProgress?.(attempts, observations);
        break;
      }
      const event = events.length === 1 ? events[0] : undefined;
      providerFailureStage = safeStage(event?.failureStage);
      const correlated = event?.event === 'ai_grounded_analysis' && event.outcome === 'failure' && event.correlationId === attemptId;
      ({ attempt, observation } = attemptFromFailure(slot, attemptId, event, correlated));
    }
    attempts.push(attempt);
    observations.push(observation);
    await options.onProgress?.(attempts, observations);
    if (observation.status === 'failure' && !['model_json_parse', 'output_schema'].includes(providerFailureStage)) {
      stopped = true;
      break;
    }
    let healthy = false;
    try { healthy = await options.healthCheck(); } catch { healthy = false; }
    if (!healthy) { stopped = true; break; }
  }
  const attempted = new Set(observations.map((item) => item.slotId));
  for (const slot of groundedEvaluationSlots) if (!attempted.has(slot.slotId)) {
    attempts.push({ slotId: slot.slotId, caseType: slot.caseType, status: 'not_attempted', correlationComplete: false });
    observations.push(emptyObservation(slot, 'not_attempted', undefined, null));
  }
  const orderedAttempts = groundedEvaluationSlots.map((slot) => attempts.find((item) => item.slotId === slot.slotId)!).filter(Boolean);
  const orderedObservations = groundedEvaluationSlots.map((slot) => observations.find((item) => item.slotId === slot.slotId)!).filter(Boolean);
  return { attempts: orderedAttempts, observations: orderedObservations, stopped };
}

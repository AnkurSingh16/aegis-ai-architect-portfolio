import { randomUUID } from 'node:crypto';
import { isAnalysisResult } from '../analysis.js';
import type { AnalysisProvider } from '../provider.js';
import type { EvaluationCase } from './dataset.js';
import { plannedEvaluationSlotCount } from './dataset.js';
import { scoreEvaluation, type EvaluationObservation, type SanitizedAnalysisFields } from './scoring.js';

const allowedFailureStages = ['provider_connection', 'provider_http', 'response_size', 'response_decode', 'response_envelope',
  'model_json_parse', 'output_schema', 'generation_timeout', 'request_cancelled', 'input_validation', 'unknown'] as const;
const allowedSchemaReasons = ['invalid_root', 'invalid_keys', 'invalid_category', 'invalid_priority', 'invalid_team',
  'invalid_next_action', 'invalid_uncertainty', 'invalid_confidence', 'invalid_rationale', 'unsafe_rationale',
  'invalid_evidence_references', 'invalid_human_review', 'unclassified'] as const;
const allowedEvidenceReasons = ['not_array', 'empty_array', 'too_many_items', 'invalid_identifier', 'duplicate_identifier'] as const;
type SafeEvent = Record<string, string | number | null>;
type ProviderFactory = (log: (event: SafeEvent) => void) => AnalysisProvider;

export interface AttemptRecord extends EvaluationObservation {
  attemptId: string;
}

export interface EvaluationRun {
  attempts: AttemptRecord[];
  score: ReturnType<typeof scoreEvaluation>;
  stoppedEarly: boolean;
  stopReason: 'none' | 'provider_or_transport_failure' | 'post_attempt_health_check_failed' | 'diagnostic_invariant_failed';
}

function allowed<T extends readonly string[]>(value: unknown, values: T): value is T[number] {
  return typeof value === 'string' && values.includes(value);
}

function numeric(event: SafeEvent | undefined, key: string): number | undefined {
  const value = event?.[key];
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function sanitizeEvent(event: SafeEvent): SafeEvent {
  const safe: SafeEvent = {};
  if (event.event === 'ai_case_analysis') safe.event = event.event;
  if (event.outcome === 'success' || event.outcome === 'failure') safe.outcome = event.outcome;
  if (typeof event.correlationId === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(event.correlationId)) {
    safe.correlationId = event.correlationId;
  }
  if (allowed(event.failureStage, allowedFailureStages)) safe.failureStage = event.failureStage;
  if (allowed(event.schemaReason, allowedSchemaReasons)) safe.schemaReason = event.schemaReason;
  if (allowed(event.evidenceReason, allowedEvidenceReasons)) safe.evidenceReason = event.evidenceReason;
  for (const key of ['latencyMs', 'promptTokens', 'generatedTokens', 'responseBytes', 'httpStatus'] as const) {
    const value = event[key];
    if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && (key !== 'httpStatus' || value <= 599)) safe[key] = value;
  }
  return safe;
}

function failureObservation(item: EvaluationCase, attemptId: string, event: SafeEvent | undefined,
  correlated: boolean): AttemptRecord {
  const stage = event?.failureStage;
  const schemaReason = event?.schemaReason;
  const evidenceReason = event?.evidenceReason;
  return {
    attemptId, slotId: item.id, caseType: item.caseType, kind: item.kind, expected: item.expected,
    status: 'failure',
    ...(allowed(stage, allowedFailureStages) ? { failureStage: stage } : { failureStage: 'unknown' }),
    ...(allowed(schemaReason, allowedSchemaReasons) ? { schemaReason } : {}),
    ...(allowed(evidenceReason, allowedEvidenceReasons) ? { evidenceReason } : {}),
    ...(numeric(event, 'latencyMs') === undefined ? {} : { latencyMs: numeric(event, 'latencyMs') }),
    ...(numeric(event, 'responseBytes') === undefined ? {} : { responseBytes: numeric(event, 'responseBytes') }),
    ...(numeric(event, 'httpStatus') === undefined ? {} : { httpStatus: numeric(event, 'httpStatus') }),
    correlationComplete: correlated,
  };
}

function safeResult(value: unknown, expectedCaseId: string): SanitizedAnalysisFields | undefined {
  if (!isAnalysisResult(value, expectedCaseId)) return undefined;
  const result = value;
  return {
    category: result.category as SanitizedAnalysisFields['category'],
    priority: result.priority as SanitizedAnalysisFields['priority'],
    recommendedTeam: result.recommendedTeam as SanitizedAnalysisFields['recommendedTeam'],
    nextAction: result.nextAction as SanitizedAnalysisFields['nextAction'],
    confidence: result.confidence,
    uncertainty: result.uncertainty as SanitizedAnalysisFields['uncertainty'],
    evidenceReferences: result.evidenceReferences as SanitizedAnalysisFields['evidenceReferences'],
    humanReviewRequired: true,
  };
}

function isContinueableModelOutputFailure(stage: string | undefined): boolean {
  return stage === 'model_json_parse' || stage === 'output_schema';
}

/** Sequential, fixed-slot provider evaluation. It never retries or calls HTTP/database application routes. */
export async function runPlannedEvaluation(items: readonly EvaluationCase[], providerFactory: ProviderFactory,
  healthCheck: () => Promise<boolean>, onProgress: (attempts: readonly AttemptRecord[]) => Promise<void> = async () => {}): Promise<EvaluationRun> {
  if (items.length !== plannedEvaluationSlotCount || new Set(items.map((item) => item.id)).size !== plannedEvaluationSlotCount) {
    throw new Error('Evaluation plan does not match the fixed six-slot contract.');
  }
  const counts = new Map<string, number>();
  for (const item of items) counts.set(item.caseType, (counts.get(item.caseType) ?? 0) + 1);
  if (counts.size !== 3 || [...counts.values()].some((count) => count !== 2)) {
    throw new Error('Evaluation plan must contain two slots per case type.');
  }
  if (!await healthCheck()) throw new Error('Local provider health preflight failed.');

  const events: SafeEvent[] = [];
  const provider = providerFactory((event) => { events.push(sanitizeEvent(event)); });
  const attempts: AttemptRecord[] = [];
  let stopReason: EvaluationRun['stopReason'] = 'none';
  for (const item of items) {
    const attemptId = randomUUID();
    const eventStart = events.length;
    let result: unknown;
    let thrown = false;
    try { result = await provider.analyze(item.storedCase, new AbortController().signal, attemptId); }
    catch { thrown = true; }
    const callEvents = events.slice(eventStart).filter((event) => event.event === 'ai_case_analysis');
    const event = callEvents.length === 1 ? callEvents[0] : undefined;
    const correlated = event?.correlationId === attemptId && event.outcome === (thrown ? 'failure' : 'success');
    if (callEvents.length !== 1 || !correlated) {
      attempts.push(failureObservation(item, attemptId, undefined, false));
      await onProgress(attempts);
      stopReason = 'diagnostic_invariant_failed';
      break;
    }
    if (thrown) {
      const observation = failureObservation(item, attemptId, event, true);
      attempts.push(observation);
      await onProgress(attempts);
      if (!isContinueableModelOutputFailure(observation.failureStage)) {
        stopReason = 'provider_or_transport_failure';
        break;
      }
    } else {
      const sanitized = safeResult(result, item.storedCase.id);
      if (!sanitized) {
        attempts.push(failureObservation(item, attemptId, undefined, false));
        await onProgress(attempts);
        stopReason = 'diagnostic_invariant_failed';
        break;
      }
      attempts.push({
        attemptId, slotId: item.id, caseType: item.caseType, kind: item.kind, expected: item.expected,
        status: 'success', result: sanitized, latencyMs: numeric(event, 'latencyMs'),
        promptTokens: numeric(event, 'promptTokens') ?? null, generatedTokens: numeric(event, 'generatedTokens') ?? null,
        correlationComplete: true,
      });
      await onProgress(attempts);
    }
    if (!await healthCheck()) {
      stopReason = 'post_attempt_health_check_failed';
      break;
    }
  }
  const completedIds = new Set(attempts.map((item) => item.slotId));
  for (const item of items) {
    if (!completedIds.has(item.id)) attempts.push({
      attemptId: '', slotId: item.id, caseType: item.caseType, kind: item.kind, expected: item.expected,
      status: 'not_attempted', correlationComplete: false,
    });
  }
  const ordered = items.map((item) => attempts.find((attempt) => attempt.slotId === item.id)!).filter(Boolean);
  return { attempts: ordered, score: scoreEvaluation(ordered), stoppedEarly: stopReason !== 'none', stopReason };
}

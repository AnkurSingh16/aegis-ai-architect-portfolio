import { randomUUID } from 'node:crypto';
import { groundedValidationReasons, parseGroundedProviderOutput, type GroundedAnalysisProvider, type GroundedSource } from '../grounded-analysis.js';
import { groundedContextSlots, type GroundedContextSlot } from './grounded-context-dataset.js';
import { createContextObservation, type ContextObservation } from './grounded-context-scoring.js';
import type { SafeProviderEvent } from './grounded-provider-diagnostics.js';

type SafeEvent = SafeProviderEvent;
type SourceBundle = { tenant: GroundedContextSlot['tenant']; sources: readonly GroundedSource[] };
type ProviderFactory = (log: (event: SafeEvent) => void) => GroundedAnalysisProvider;

export interface ContextAttempt {
  slotId: string;
  caseId: string;
  status: 'success' | 'failure' | 'not_attempted';
  groundingState?: 'SUPPORTED' | 'INSUFFICIENT_EVIDENCE';
  category?: string;
  priority?: string;
  recommendedTeam?: string;
  nextAction?: string;
  citationCount?: number;
  humanReviewRequired?: true;
  failureStage?: string;
  validationReason?: string;
  latencyMs?: number | null;
  promptTokens?: number | null;
  generatedTokens?: number | null;
  correlationComplete: boolean;
}

export interface ContextEvaluationRun {
  attempts: ContextAttempt[];
  observations: ContextObservation[];
  stopped: boolean;
}

function validateSlots(slots: readonly GroundedContextSlot[]): void {
  if (slots.length !== 6 || new Set(slots.map((slot) => slot.slotId)).size !== 6 ||
      new Set(slots.map((slot) => slot.caseId)).size !== 3) throw new Error('Context evaluation plan is invalid.');
  for (const slot of slots) {
    if (!slot.caseFacts || slot.caseFacts.normalize('NFC') !== slot.caseFacts || Buffer.byteLength(slot.caseFacts, 'utf8') > 2048) {
      throw new Error('Context evaluation facts are missing or outside the approved bound.');
    }
  }
}

function safeStage(event: SafeEvent | undefined): string {
  const allowed = ['provider_connection', 'provider_http', 'response_size', 'response_decode', 'response_envelope', 'model_json_parse',
    'output_schema', 'generation_timeout', 'request_cancelled', 'input_validation', 'unknown'];
  return typeof event?.failureStage === 'string' && allowed.includes(event.failureStage) ? event.failureStage : 'unknown';
}

/** Six sequential provider calls at most. No HTTP, database, retries, or label fields enter the provider input. */
export async function runGroundedContextEvaluation(options: {
  providerFactory: ProviderFactory;
  healthCheck: () => Promise<boolean>;
  sourcesFor: (slot: GroundedContextSlot) => SourceBundle;
  slots?: readonly GroundedContextSlot[];
  onProgress?: (attempts: readonly ContextAttempt[], observations: readonly ContextObservation[]) => Promise<void>;
}): Promise<ContextEvaluationRun> {
  const slots = options.slots ?? groundedContextSlots;
  validateSlots(slots);
  const attempts: ContextAttempt[] = [];
  const observations: ContextObservation[] = [];
  let stopped = false;
  let healthy = false;
  try { healthy = await options.healthCheck(); } catch { healthy = false; }
  if (!healthy) {
    stopped = true;
    for (const slot of slots) {
      attempts.push({ slotId: slot.slotId, caseId: slot.caseId, status: 'not_attempted', correlationComplete: false });
      observations.push(createContextObservation(slot, 'not_attempted'));
    }
    await options.onProgress?.(attempts, observations);
    return { attempts, observations, stopped };
  }

  for (const slot of slots) {
    try { healthy = await options.healthCheck(); } catch { healthy = false; }
    if (!healthy) { stopped = true; break; }
    const bundle = options.sourcesFor(slot);
    if (bundle.tenant !== slot.tenant || bundle.sources.length < 1 || bundle.sources.length > 5 ||
        bundle.sources.some((source) => source.sourceIdentity !== slot.sourceIdentity || source.version !== slot.sourceVersion)) {
      throw new Error('Context evaluation source tenant or count is invalid.');
    }
    const attemptId = randomUUID();
    const events: SafeEvent[] = [];
    let response: Awaited<ReturnType<GroundedAnalysisProvider['analyze']>>;
    try {
      const provider = options.providerFactory((event) => events.push(event));
      response = await provider.analyze({ caseStatus: 'in_progress', caseType: slot.caseId, caseFacts: slot.caseFacts,
        sources: bundle.sources }, new AbortController().signal, attemptId);
      const output = parseGroundedProviderOutput(response.output, bundle.sources);
      const event = events.length === 1 ? events[0] : undefined;
      const correlationComplete = event?.event === 'ai_grounded_analysis' && event.outcome === 'success' && event.correlationId === attemptId;
      if (!correlationComplete) throw new Error('correlation');
      const cited = new Set(output.citations);
      const sourceCoverage = output.groundingState === 'SUPPORTED' && bundle.sources.some((source) => cited.has(source.citationId) &&
        source.sourceIdentity === slot.sourceIdentity && bundle.tenant === slot.tenant);
      const observation = createContextObservation(slot, 'success', {
        groundingState: output.groundingState, parsedJson: true, schemaAccepted: true, citationsValid: true,
        sourceCoverage, humanReviewRequired: output.humanReviewRequired, semanticGroundingReviewed: null, correlationComplete: true,
        ...(output.groundingState === 'SUPPORTED' ? { category: output.category, priority: output.priority,
          recommendedTeam: output.recommendedTeam, nextAction: output.nextAction } : {}),
        latencyMs: response.metrics.latencyMs, promptTokens: response.metrics.promptTokens, generatedTokens: response.metrics.generatedTokens,
      });
      observations.push(observation);
      attempts.push({ slotId: slot.slotId, caseId: slot.caseId, status: 'success', groundingState: output.groundingState,
        ...(output.groundingState === 'SUPPORTED' ? { category: output.category, priority: output.priority,
          recommendedTeam: output.recommendedTeam, nextAction: output.nextAction } : {}),
        citationCount: output.citations.length, humanReviewRequired: true, latencyMs: response.metrics.latencyMs,
        promptTokens: response.metrics.promptTokens, generatedTokens: response.metrics.generatedTokens, correlationComplete: true });
    } catch {
      const event = events.length === 1 ? events[0] : undefined;
      const failureStage = safeStage(event);
      const correlated = event?.event === 'ai_grounded_analysis' && event.outcome === 'failure' && event.correlationId === attemptId;
      const validationReason = typeof event?.validationReason === 'string' && groundedValidationReasons.includes(event.validationReason as never)
        ? event.validationReason : undefined;
      attempts.push({ slotId: slot.slotId, caseId: slot.caseId, status: 'failure', failureStage,
        ...(validationReason ? { validationReason } : {}), latencyMs: typeof event?.latencyMs === 'number' ? event.latencyMs : null,
        correlationComplete: correlated });
      observations.push(createContextObservation(slot, 'failure', { failureStage, parsedJson: failureStage === 'output_schema' ? true :
        failureStage === 'model_json_parse' ? false : null, schemaAccepted: failureStage === 'output_schema' ? false : null,
        citationsValid: event?.schemaReason === 'invalid_citations' ? false : null, correlationComplete: correlated,
        latencyMs: typeof event?.latencyMs === 'number' ? event.latencyMs : null }));
      if (!['output_schema', 'model_json_parse'].includes(failureStage)) stopped = true;
    }
    await options.onProgress?.(attempts, observations);
    if (stopped) break;
  }
  const seen = new Set(observations.map((item) => item.slotId));
  for (const slot of slots) if (!seen.has(slot.slotId)) {
    attempts.push({ slotId: slot.slotId, caseId: slot.caseId, status: 'not_attempted', correlationComplete: false });
    observations.push(createContextObservation(slot, 'not_attempted'));
  }
  return { attempts: slots.map((slot) => attempts.find((item) => item.slotId === slot.slotId)!),
    observations: slots.map((slot) => observations.find((item) => item.slotId === slot.slotId)!), stopped };
}

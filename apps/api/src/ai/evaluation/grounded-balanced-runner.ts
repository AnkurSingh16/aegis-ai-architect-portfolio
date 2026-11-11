import { randomUUID } from 'node:crypto';
import { GroundedOutputError, groundedValidationReasons, parseGroundedProviderOutput,
  type GroundedAnalysisProvider, type GroundedSource } from '../grounded-analysis.js';
import { groundedBalancedScenarios, validateGroundedBalancedDataset, type GroundedBalancedScenario } from './grounded-balanced-dataset.js';
import { createBalancedObservation, type BalancedObservation } from './grounded-balanced-scoring.js';
import { normalizeGroundedProviderDiagnostics, type SafeProviderEvent } from './grounded-provider-diagnostics.js';

type ProviderFactory = (log: (event: SafeProviderEvent) => void) => GroundedAnalysisProvider;
type SourceBundle = { tenant: GroundedBalancedScenario['tenant']; sources: GroundedSource[] };
export interface BalancedAttempt {
  scenarioId: string;
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
  latencyMs: number | null;
  promptTokens: number | null;
  generatedTokens: number | null;
  correlationComplete: boolean;
}

export interface BalancedRun { attempts: BalancedAttempt[]; observations: BalancedObservation[]; stopped: boolean }

const failureStages = ['provider_connection', 'provider_http', 'response_size', 'response_decode', 'response_envelope', 'model_json_parse',
  'output_schema', 'generation_timeout', 'request_cancelled', 'input_validation', 'unknown'] as const;

function safeNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function eventFailure(event: SafeProviderEvent | undefined): { stage: string; reason: string | null } {
  const stage = typeof event?.failureStage === 'string' && failureStages.includes(event.failureStage as typeof failureStages[number])
    ? event.failureStage : 'unknown';
  const reason = typeof event?.validationReason === 'string' && groundedValidationReasons.includes(event.validationReason as never)
    ? event.validationReason : null;
  return { stage, reason };
}

function validateEvaluationPlan(scenarios: readonly GroundedBalancedScenario[]): void {
  validateGroundedBalancedDataset(scenarios);
  if (scenarios.length !== 6) throw new Error('Balanced evaluation plan must contain six cases.');
}

/** Runs one provider request per distinct scenario, sequentially; no DB, HTTP app, or retry path exists. */
export async function runGroundedBalancedEvaluation(options: {
  providerFactory: ProviderFactory;
  healthCheck: () => Promise<boolean>;
  sourcesFor: (scenario: GroundedBalancedScenario) => SourceBundle;
  scenarios?: readonly GroundedBalancedScenario[];
  onProgress?: (attempts: readonly BalancedAttempt[], observations: readonly BalancedObservation[]) => Promise<void>;
}): Promise<BalancedRun> {
  const scenarios = options.scenarios ?? groundedBalancedScenarios;
  validateEvaluationPlan(scenarios);
  const attempts: BalancedAttempt[] = [];
  const observations: BalancedObservation[] = [];
  let stopped = false;
  for (const scenario of scenarios) {
    let healthy = false;
    try { healthy = await options.healthCheck(); } catch { healthy = false; }
    if (!healthy) { stopped = true; break; }
    const bundle = options.sourcesFor(scenario);
    if (bundle.tenant !== scenario.tenant || bundle.sources.length !== scenario.sources.length || bundle.sources.length > 5 ||
        new Set(bundle.sources.map((item) => item.citationId)).size !== bundle.sources.length ||
        new Set(bundle.sources.map((item) => item.sourceIdentity)).size !== bundle.sources.length ||
        bundle.sources.some((item) => {
          const expected = scenario.sources.find((fixture) => fixture.sourceIdentity === item.sourceIdentity);
          return !expected || item.title !== expected.title || item.version !== expected.version || item.position !== 0 || item.content !== expected.content ||
            !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(item.citationId);
        })) throw new Error('Balanced evaluation source boundary is invalid.');

    const correlationId = randomUUID();
    const events: SafeProviderEvent[] = [];
    try {
      const provider = options.providerFactory((event) => events.push(event));
      const response = await provider.analyze({ caseStatus: 'in_progress', caseType: scenario.caseType,
        caseFacts: scenario.caseFacts, sources: bundle.sources }, new AbortController().signal, correlationId);
      const output = parseGroundedProviderOutput(response.output, bundle.sources);
      const event = events.length === 1 ? events[0] : undefined;
      const correlated = event?.event === 'ai_grounded_analysis' && event.outcome === 'success' && event.correlationId === correlationId;
      if (!correlated) throw new Error('correlation');
      const sourceByCitation = new Map(bundle.sources.map((item) => [item.citationId, item.sourceIdentity]));
      const citedExpectedSourceIdentities = output.groundingState === 'SUPPORTED'
        ? [...new Set(output.citations.flatMap((citation) => {
          const identity = sourceByCitation.get(citation);
          return identity && scenario.expectedSourceIdentities.includes(identity) ? [identity] : [];
        }))] : [];
      const observation = createBalancedObservation(scenario, 'success', {
        groundingState: output.groundingState, parsedJson: true, schemaAccepted: true,
        citationsValid: output.groundingState === 'SUPPORTED' ? true : null,
        citedExpectedSourceIdentities, humanReviewRequired: output.humanReviewRequired, correlationComplete: true,
        providerDiagnostics: normalizeGroundedProviderDiagnostics(event, correlationId),
        ...(output.groundingState === 'SUPPORTED' ? { category: output.category, priority: output.priority,
          recommendedTeam: output.recommendedTeam, nextAction: output.nextAction } : {}),
        latencyMs: response.metrics.latencyMs, promptTokens: response.metrics.promptTokens, generatedTokens: response.metrics.generatedTokens,
      });
      observations.push(observation);
      attempts.push({ scenarioId: scenario.scenarioId, status: 'success', groundingState: output.groundingState,
        ...(output.groundingState === 'SUPPORTED' ? { category: output.category, priority: output.priority,
          recommendedTeam: output.recommendedTeam, nextAction: output.nextAction } : {}),
        citationCount: output.citations.length, humanReviewRequired: true, latencyMs: response.metrics.latencyMs,
        promptTokens: response.metrics.promptTokens, generatedTokens: response.metrics.generatedTokens, correlationComplete: true });
    } catch (error) {
      const event = events.length === 1 ? events[0] : undefined;
      const classified = eventFailure(event);
      const isSchemaError = error instanceof GroundedOutputError || classified.stage === 'output_schema';
      const correlated = event?.event === 'ai_grounded_analysis' && event.outcome === 'failure' && event.correlationId === correlationId;
      const observation = createBalancedObservation(scenario, 'failure', {
        parsedJson: classified.stage === 'output_schema' ? true : classified.stage === 'model_json_parse' ? false : null,
        schemaAccepted: isSchemaError ? false : null,
        citationsValid: event?.schemaReason === 'invalid_citations' ? false : null,
        humanReviewRequired: classified.reason === 'invalid_human_review' ? false : null,
        correlationComplete: correlated,
        providerDiagnostics: normalizeGroundedProviderDiagnostics(event, correlationId),
        failureStage: classified.stage,
        validationReason: classified.reason,
        latencyMs: safeNumber(event?.latencyMs),
      });
      observations.push(observation);
      attempts.push({ scenarioId: scenario.scenarioId, status: 'failure', failureStage: classified.stage,
        validationReason: classified.reason ?? undefined, latencyMs: safeNumber(event?.latencyMs), promptTokens: null,
        generatedTokens: null, correlationComplete: correlated });
      if (!['output_schema', 'model_json_parse'].includes(classified.stage)) stopped = true;
    }
    await options.onProgress?.(attempts, observations);
    if (stopped) break;
  }
  const seen = new Set(observations.map((item) => item.scenarioId));
  for (const scenario of scenarios) if (!seen.has(scenario.scenarioId)) {
    observations.push(createBalancedObservation(scenario, 'not_attempted'));
    attempts.push({ scenarioId: scenario.scenarioId, status: 'not_attempted', latencyMs: null, promptTokens: null,
      generatedTokens: null, correlationComplete: false });
  }
  return { attempts: scenarios.map((scenario) => attempts.find((item) => item.scenarioId === scenario.scenarioId)!),
    observations: scenarios.map((scenario) => observations.find((item) => item.scenarioId === scenario.scenarioId)!), stopped };
}

import { groundedValidationReasons, type GroundedValidationReason } from '../grounded-analysis.js';

export const groundedFailureStages = ['input_validation', 'provider_connection', 'provider_http', 'response_size', 'response_decode',
  'response_envelope', 'model_json_parse', 'output_schema', 'generation_timeout', 'request_cancelled', 'unknown'] as const;
export const groundedCompletionReasons = ['stop', 'length'] as const;
export type GroundedCompletionReason = typeof groundedCompletionReasons[number];
export type SafeProviderEventValue = string | number | boolean | null;
export type SafeProviderEvent = Record<string, SafeProviderEventValue>;

export interface GroundedProviderDiagnostics {
  failureStage: typeof groundedFailureStages[number] | null;
  validationReason: GroundedValidationReason | null;
  envelopeBytes: number | null;
  modelOutputBytes: number | null;
  promptTokens: number | null;
  generatedTokens: number | null;
  completionReason: GroundedCompletionReason | null;
  outputLimitReached: boolean | null;
  latencyMs: number | null;
  correlationComplete: boolean;
}

const maxEnvelopeBytes = 8192;
const maxModelOutputBytes = 4096;
const maxTokenCount = 1_000_000;
const maxLatencyMs = 60_000;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function boundedInteger(value: unknown, maximum: number): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= maximum ? value : null;
}

function safeFailureStage(value: unknown): GroundedProviderDiagnostics['failureStage'] {
  return typeof value === 'string' && groundedFailureStages.includes(value as typeof groundedFailureStages[number])
    ? value as typeof groundedFailureStages[number] : null;
}

function safeValidationReason(value: unknown): GroundedValidationReason | null {
  return typeof value === 'string' && groundedValidationReasons.includes(value as GroundedValidationReason)
    ? value as GroundedValidationReason : null;
}

function safeCompletionReason(value: unknown): GroundedCompletionReason | null {
  return typeof value === 'string' && groundedCompletionReasons.includes(value as GroundedCompletionReason)
    ? value as GroundedCompletionReason : null;
}

/** Projects a provider event into fixed, bounded report fields. Unknown provider data is discarded. */
export function normalizeGroundedProviderDiagnostics(event: unknown, expectedCorrelationId: string): GroundedProviderDiagnostics {
  if (!record(event)) return { failureStage: null, validationReason: null, envelopeBytes: null, modelOutputBytes: null,
    promptTokens: null, generatedTokens: null, completionReason: null, outputLimitReached: null, latencyMs: null,
    correlationComplete: false };
  const completionReason = safeCompletionReason(event.completionReason);
  return {
    failureStage: safeFailureStage(event.failureStage),
    validationReason: safeValidationReason(event.validationReason),
    envelopeBytes: boundedInteger(event.envelopeBytes, maxEnvelopeBytes + 1),
    modelOutputBytes: boundedInteger(event.modelOutputBytes, maxModelOutputBytes + 1),
    promptTokens: boundedInteger(event.promptTokens, maxTokenCount),
    generatedTokens: boundedInteger(event.generatedTokens, maxTokenCount),
    completionReason,
    outputLimitReached: completionReason === 'length' ? true : completionReason === 'stop' ? false : null,
    latencyMs: boundedInteger(event.latencyMs, maxLatencyMs),
    correlationComplete: event.event === 'ai_grounded_analysis' && (event.outcome === 'success' || event.outcome === 'failure')
      ? event.correlationId === expectedCorrelationId && typeof expectedCorrelationId === 'string' && expectedCorrelationId.length > 0
      : false,
  };
}

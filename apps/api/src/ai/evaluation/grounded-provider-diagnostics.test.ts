import { describe, expect, it } from 'vitest';
import { normalizeGroundedProviderDiagnostics } from './grounded-provider-diagnostics.js';

describe('grounded provider diagnostics normalization', () => {
  const correlationId = 'correlation-safe-id';

  it('keeps only bounded allowlisted diagnostics and derives the limit flag from completion metadata', () => {
    expect(normalizeGroundedProviderDiagnostics({ event: 'ai_grounded_analysis', outcome: 'failure',
      correlationId, failureStage: 'model_json_parse', validationReason: 'unknown_citation', envelopeBytes: 8192,
      modelOutputBytes: 4096, promptTokens: 900, generatedTokens: 256, completionReason: 'length', latencyMs: 1200,
      response: 'raw response', prompt: 'synthetic prompt', sourceText: 'private source', rationale: 'private rationale',
      token: 'secret', citationId: 'private-id', arbitrary: { data: 'discard' } }, correlationId)).toEqual({
      failureStage: 'model_json_parse', validationReason: 'unknown_citation', envelopeBytes: 8192, modelOutputBytes: 4096,
      promptTokens: 900, generatedTokens: 256, completionReason: 'length', outputLimitReached: true, latencyMs: 1200,
      correlationComplete: true,
    });
  });

  it('does not infer output-limit exhaustion from a parse failure without completion metadata', () => {
    expect(normalizeGroundedProviderDiagnostics({ event: 'ai_grounded_analysis', outcome: 'failure', failureStage: 'model_json_parse',
      latencyMs: 50, correlationId }, correlationId)).toMatchObject({ failureStage: 'model_json_parse',
      completionReason: null, outputLimitReached: null, correlationComplete: true });
    expect(normalizeGroundedProviderDiagnostics({ outcome: 'failure', correlationId }, correlationId).correlationComplete).toBe(false);
  });

  it('maps missing, malformed, oversized, unknown, and mismatched metadata to null or false', () => {
    expect(normalizeGroundedProviderDiagnostics({ outcome: 'failure', failureStage: 'raw model error',
      validationReason: 'raw parser message', envelopeBytes: 9000, modelOutputBytes: -1, promptTokens: 1_000_001,
      generatedTokens: '256', completionReason: 'x'.repeat(5000), latencyMs: 60_001,
      correlationId: 'different-id', outputLimitReached: true }, correlationId)).toEqual({
      failureStage: null, validationReason: null, envelopeBytes: null, modelOutputBytes: null, promptTokens: null,
      generatedTokens: null, completionReason: null, outputLimitReached: null, latencyMs: null, correlationComplete: false,
    });
  });
});

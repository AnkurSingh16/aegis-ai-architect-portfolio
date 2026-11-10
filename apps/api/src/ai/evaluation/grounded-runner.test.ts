import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { GroundedAnalysisProvider, GroundedProviderOutput, GroundedSource } from '../grounded-analysis.js';
import { groundedEvaluationSlots, scoreGroundedEvaluation } from './grounded-scoring.js';
import { runGroundedProviderEvaluation } from './grounded-runner.js';

const secretText = 'SYNTHETIC-PRIVATE-RAW-RESPONSE-DO-NOT-REPORT';
function sourcesFor(caseType: string): GroundedSource[] {
  return [{ citationId: randomUUID(), title: 'Synthetic evaluation source', sourceIdentity: groundedEvaluationSlots.find((slot) => slot.caseType === caseType)!.expectedSourceIdentity,
    version: 1, position: 0, content: 'Synthetic source content never persisted in evaluation reports.' }];
}
function supported(input: { sources: readonly GroundedSource[] }): GroundedProviderOutput {
  return { groundingState: 'SUPPORTED', category: 'incident', priority: 'high', recommendedTeam: 'Platform support',
    rationale: secretText, nextAction: 'Review the synthetic service impact and incident timeline.', citations: [input.sources[0]!.citationId],
    confidence: 0.72, uncertainty: 'moderate', humanReviewRequired: true };
}
const successProvider = (calls: string[]) => (log: (event: Record<string, string | number | null>) => void): GroundedAnalysisProvider => ({
  model: 'synthetic-test-model',
  async analyze(input, _signal, correlationId) {
    calls.push(input.caseType);
    log({ event: 'ai_grounded_analysis', outcome: 'success', correlationId, latencyMs: 42, model: 'synthetic-test-model' });
    return { output: supported(input), metrics: { latencyMs: 42, promptTokens: 31, generatedTokens: 17 } };
  },
});

describe('bounded grounded provider evaluation runner', () => {
  it('uses exactly the six fixed slots once each and strips prompt/response text from reports', async () => {
    const calls: string[] = [];
    const run = await runGroundedProviderEvaluation({ providerFactory: successProvider(calls), sourcesFor,
      healthCheck: async () => true });
    expect(groundedEvaluationSlots).toHaveLength(6);
    expect(calls).toHaveLength(6);
    expect(run.attempts).toHaveLength(6);
    expect(run.attempts.every((attempt) => attempt.status === 'success' && attempt.correlationComplete)).toBe(true);
    expect(run.attempts[0]).toMatchObject({ confidence: 0.72, uncertainty: 'moderate', humanReviewRequired: true });
    const safeReport = JSON.stringify({ attempts: run.attempts, observations: run.observations, score: scoreGroundedEvaluation(run.observations) });
    expect(safeReport).not.toContain(secretText);
    expect(safeReport).not.toContain('Synthetic source content');
    expect(safeReport).not.toContain('rationale');
    expect(run.observations[0]).toMatchObject({ groundingState: 'SUPPORTED', evidenceCoverage: true,
      groundednessReviewAgreement: null, expectedSourceIdentity: groundedEvaluationSlots[0]!.expectedSourceIdentity });
  });

  it('records a valid abstention distinctly from a failed provider attempt', async () => {
    const calls: string[] = [];
    const providerFactory = (log: (event: Record<string, string | number | null>) => void): GroundedAnalysisProvider => ({
      model: 'synthetic-test-model', async analyze(input, _signal, correlationId) {
        calls.push(input.caseType);
        log({ event: 'ai_grounded_analysis', outcome: 'success', correlationId, latencyMs: 20 });
        return { output: { groundingState: 'INSUFFICIENT_EVIDENCE', category: null, priority: null, recommendedTeam: null,
          rationale: null, nextAction: null, citations: [], confidence: null, uncertainty: 'high', humanReviewRequired: true },
        metrics: { latencyMs: 20, promptTokens: null, generatedTokens: 10 } };
      },
    });
    const run = await runGroundedProviderEvaluation({ providerFactory, sourcesFor, healthCheck: async () => true });
    expect(calls).toHaveLength(6);
    expect(run.observations[0]).toMatchObject({ status: 'success', groundingState: 'INSUFFICIENT_EVIDENCE', humanReviewRequired: true });
    expect(scoreGroundedEvaluation(run.observations).metrics.groundingStates).toEqual({ supported: 0, insufficientEvidence: 6, denominator: 6 });
    expect(scoreGroundedEvaluation(run.observations).metrics.groundingStateAgreement.rate).toBe(0);
  });

  it('does not invoke the provider when health fails before a slot', async () => {
    const calls = vi.fn();
    let checks = 0;
    const run = await runGroundedProviderEvaluation({ providerFactory: () => ({ model: 'synthetic', analyze: calls }), sourcesFor,
      healthCheck: async () => ++checks === 1 });
    expect(calls).not.toHaveBeenCalled();
    expect(run.stopped).toBe(true);
    expect(run.observations.every((item) => item.status === 'not_attempted')).toBe(true);
  });

  it('records one sanitized transport failure then stops without retrying', async () => {
    const calls = vi.fn(async (_input: unknown, _signal: AbortSignal, correlationId: string) => {
      log({ event: 'ai_grounded_analysis', outcome: 'failure', failureStage: 'provider_http', correlationId, latencyMs: 8,
        privateResponse: secretText });
      throw new Error(secretText);
    });
    let log: (event: Record<string, string | number | null>) => void = () => {};
    const providerFactory = (sink: typeof log): GroundedAnalysisProvider => {
      log = sink;
      return { model: 'synthetic', analyze: calls as GroundedAnalysisProvider['analyze'] };
    };
    const run = await runGroundedProviderEvaluation({ providerFactory, sourcesFor, healthCheck: async () => true });
    expect(calls).toHaveBeenCalledOnce();
    expect(run.attempts[0]).toMatchObject({ status: 'failure', failureStage: 'provider_http', correlationComplete: true });
    expect(run.attempts.slice(1).every((item) => item.status === 'not_attempted')).toBe(true);
    expect(JSON.stringify(run)).not.toContain(secretText);
  });

  it('keeps a single schema-rejected slot as a failed observation and continues to distinct planned slots', async () => {
    let calls = 0;
    const providerFactory = (log: (event: Record<string, string | number | null>) => void): GroundedAnalysisProvider => ({
      model: 'synthetic', async analyze(input, _signal, correlationId) {
        calls += 1;
        if (calls === 1) {
          log({ event: 'ai_grounded_analysis', outcome: 'failure', failureStage: 'output_schema', schemaReason: 'invalid_citations',
            correlationId, latencyMs: 5 });
          throw new Error(secretText);
        }
        log({ event: 'ai_grounded_analysis', outcome: 'success', correlationId, latencyMs: 5 });
        return { output: supported(input), metrics: { latencyMs: 5, promptTokens: null, generatedTokens: null } };
      },
    });
    const run = await runGroundedProviderEvaluation({ providerFactory, sourcesFor, healthCheck: async () => true });
    expect(calls).toBe(6);
    expect(run.attempts[0]).toMatchObject({ status: 'failure', failureStage: 'output_schema', schemaReason: 'invalid_citations' });
    expect(run.attempts.slice(1).every((attempt) => attempt.status === 'success')).toBe(true);
    expect(JSON.stringify(run)).not.toContain(secretText);
  });
});

import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { GroundedAnalysisProvider, GroundedProviderOutput, GroundedSource } from '../grounded-analysis.js';
import { groundedBalancedScenarios } from './grounded-balanced-dataset.js';
import { runGroundedBalancedEvaluation } from './grounded-balanced-runner.js';
import { scoreGroundedBalancedEvaluation } from './grounded-balanced-scoring.js';
import type { SafeProviderEvent } from './grounded-provider-diagnostics.js';

const secretLabelMarker = 'private-engineering-label-rationale-must-never-be-provider-input';

function sourceBundle(scenario: typeof groundedBalancedScenarios[number]) {
  return { tenant: scenario.tenant, sources: scenario.sources.map((item): GroundedSource => ({ citationId: randomUUID(), title: item.title,
    sourceIdentity: item.sourceIdentity, version: item.version, position: 0, content: item.content })) };
}

function expectedOutput(scenario: typeof groundedBalancedScenarios[number], sources: readonly GroundedSource[]): GroundedProviderOutput {
  if (!scenario.expected) return { groundingState: 'INSUFFICIENT_EVIDENCE', category: null, priority: null, recommendedTeam: null,
    rationale: null, nextAction: null, citations: [], confidence: null, uncertainty: 'high', humanReviewRequired: true };
  return { groundingState: 'SUPPORTED', ...scenario.expected, rationale: 'A human reviewer should verify this synthetic evidence.',
    citations: sources.map((item) => item.citationId), confidence: 0.5, uncertainty: 'moderate', humanReviewRequired: true };
}

describe('balanced grounded evaluation runner', () => {
  it('passes only case facts and retrieved source DTOs, never labels or review rationales', async () => {
    const captured: unknown[] = [];
    let concurrent = 0;
    let maxConcurrent = 0;
    const scenarios = groundedBalancedScenarios.map((item, index) => index === 0 ? { ...item, reviewRationale: secretLabelMarker } : item);
    const run = await runGroundedBalancedEvaluation({
      healthCheck: async () => true,
      sourcesFor: sourceBundle,
      providerFactory: (log) => ({ model: 'mock', async analyze(input, _signal, correlationId) {
        captured.push(input);
        concurrent++;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        const scenario = scenarios.find((item) => item.caseFacts === input.caseFacts)!;
        const sources = input.sources;
        await Promise.resolve();
        concurrent--;
        log({ event: 'ai_grounded_analysis', outcome: 'success', correlationId, latencyMs: 2 });
        return { output: expectedOutput(scenario, sources), metrics: { latencyMs: 2, promptTokens: 11, generatedTokens: 17 } };
      } }),
      scenarios,
    });
    expect(run.attempts).toHaveLength(6);
    expect(run.attempts.every((item) => item.status === 'success')).toBe(true);
    expect(captured).toHaveLength(6);
    expect(maxConcurrent).toBe(1);
    expect(JSON.stringify(captured)).not.toContain(secretLabelMarker);
    expect(JSON.stringify(captured)).not.toContain('reviewRationale');
    expect(JSON.stringify(captured)).not.toContain('expectedGroundingState');
    expect(JSON.stringify(captured)).not.toContain('expectedSourceIdentities');
    expect(Object.keys(captured[0] as Record<string, unknown>).sort()).toEqual(['caseFacts', 'caseStatus', 'caseType', 'sources']);
    expect(run.observations.filter((item) => item.expectedGroundingState === 'SUPPORTED' && item.groundingState === 'SUPPORTED')).toHaveLength(3);
    expect(run.observations.filter((item) => item.expectedGroundingState === 'INSUFFICIENT_EVIDENCE' && item.groundingState === 'INSUFFICIENT_EVIDENCE')).toHaveLength(3);
  });

  it('rejects cross-tenant, stale, or altered source fixtures before provider invocation', async () => {
    const provider = vi.fn();
    const wrongTenant = (scenario: typeof groundedBalancedScenarios[number]) => ({ ...sourceBundle(scenario), tenant: scenario.tenant === 'north' ? 'south' as const : 'north' as const });
    await expect(runGroundedBalancedEvaluation({ providerFactory: () => ({ model: 'mock', analyze: provider }),
      healthCheck: async () => true, sourcesFor: wrongTenant })).rejects.toThrow(/source boundary/);
    await expect(runGroundedBalancedEvaluation({ providerFactory: () => ({ model: 'mock', analyze: provider }), healthCheck: async () => true,
      sourcesFor: (scenario) => ({ ...sourceBundle(scenario), sources: sourceBundle(scenario).sources.map((source) => ({ ...source,
        version: 2, content: `${source.content} changed` })) }) })).rejects.toThrow(/source boundary/);
    expect(provider).not.toHaveBeenCalled();
  });

  it('makes no retry for a failed slot and stops safely after a provider transport failure', async () => {
    const provider = vi.fn(async (_input: unknown, _signal: AbortSignal, correlationId: string) => {
      log({ event: 'ai_grounded_analysis', outcome: 'failure', correlationId, failureStage: 'provider_http', latencyMs: 9 });
      throw new Error(secretLabelMarker);
    });
    let log: (event: SafeProviderEvent) => void = () => undefined;
    const run = await runGroundedBalancedEvaluation({ healthCheck: async () => true, sourcesFor: sourceBundle,
      providerFactory: (emit) => { log = emit; return { model: 'mock', analyze: provider as GroundedAnalysisProvider['analyze'] }; } });
    expect(provider).toHaveBeenCalledOnce();
    expect(run.attempts[0]?.status).toBe('failure');
    expect(run.attempts.slice(1).every((item) => item.status === 'not_attempted')).toBe(true);
    expect(JSON.stringify(run)).not.toContain(secretLabelMarker);
  });

  it('returns all slots as not attempted when the read-only health preflight fails', async () => {
    const provider = vi.fn();
    const run = await runGroundedBalancedEvaluation({ healthCheck: async () => false, sourcesFor: sourceBundle,
      providerFactory: () => ({ model: 'mock', analyze: provider }) });
    expect(run.attempts).toHaveLength(6);
    expect(run.attempts.every((item) => item.status === 'not_attempted')).toBe(true);
    expect(provider).not.toHaveBeenCalled();
  });

  it('counts a known human-review validation failure in the enforcement denominator', async () => {
    const providerFactory = (log: (event: SafeProviderEvent) => void): GroundedAnalysisProvider => ({
      model: 'mock', async analyze(input, _signal, correlationId) {
        if (input.caseFacts === groundedBalancedScenarios[0]!.caseFacts) {
          log({ event: 'ai_grounded_analysis', outcome: 'failure', correlationId, failureStage: 'output_schema',
            schemaReason: 'invalid_output', validationReason: 'invalid_human_review', latencyMs: 8 });
          throw new Error(secretLabelMarker);
        }
        const scenario = groundedBalancedScenarios.find((item) => item.caseFacts === input.caseFacts)!;
        log({ event: 'ai_grounded_analysis', outcome: 'success', correlationId, latencyMs: 4 });
        return { output: expectedOutput(scenario, input.sources), metrics: { latencyMs: 4, promptTokens: null, generatedTokens: null } };
      },
    });
    const run = await runGroundedBalancedEvaluation({ healthCheck: async () => true, sourcesFor: sourceBundle, providerFactory });
    const score = scoreGroundedBalancedEvaluation(run.observations);
    expect(run.observations[0]?.humanReviewRequired).toBe(false);
    expect(score.metrics.humanReviewEnforcement).toEqual({ numerator: 5, denominator: 6, rate: 0.8333, state: 'measured' });
    expect(run.attempts[0]?.validationReason).toBe('invalid_human_review');
  });

  it('counts rejected invalid citations in citation validity without turning the response into an accepted output', async () => {
    const providerFactory = (log: (event: SafeProviderEvent) => void): GroundedAnalysisProvider => ({
      model: 'mock', async analyze(input, _signal, correlationId) {
        if (input.caseFacts === groundedBalancedScenarios[0]!.caseFacts) {
          log({ event: 'ai_grounded_analysis', outcome: 'failure', correlationId, failureStage: 'output_schema',
            schemaReason: 'invalid_citations', validationReason: 'unknown_citation', latencyMs: 6 });
          throw new Error(secretLabelMarker);
        }
        const scenario = groundedBalancedScenarios.find((item) => item.caseFacts === input.caseFacts)!;
        log({ event: 'ai_grounded_analysis', outcome: 'success', correlationId, latencyMs: 4 });
        return { output: expectedOutput(scenario, input.sources), metrics: { latencyMs: 4, promptTokens: null, generatedTokens: null } };
      },
    });
    const run = await runGroundedBalancedEvaluation({ healthCheck: async () => true, sourcesFor: sourceBundle, providerFactory });
    const score = scoreGroundedBalancedEvaluation(run.observations);
    expect(run.attempts[0]?.status).toBe('failure');
    expect(run.attempts[0]?.validationReason).toBe('unknown_citation');
    expect(run.observations[0]?.schemaAccepted).toBe(false);
    expect(score.metrics.citationIdentityValidity).toEqual({ numerator: 2, denominator: 3, rate: 0.6667, state: 'measured' });
    expect(score.metrics.strictSchemaAcceptance).toEqual({ numerator: 5, denominator: 6, rate: 0.8333, state: 'measured' });
  });
});

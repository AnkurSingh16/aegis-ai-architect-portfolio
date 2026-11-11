import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { GroundedAnalysisProvider, GroundedProviderOutput, GroundedSource } from '../grounded-analysis.js';
import { groundedContextSlots, resolveGroundedContextSource } from './grounded-context-dataset.js';
import { runGroundedContextEvaluation } from './grounded-context-runner.js';
import type { SafeProviderEvent } from './grounded-provider-diagnostics.js';

const privateLabel = 'EXPECTED_LABEL_AND_REVIEW_RATIONALE_MUST_NOT_ENTER_PROMPT';
const abstention = { groundingState: 'INSUFFICIENT_EVIDENCE' as const, category: null, priority: null, recommendedTeam: null,
  rationale: null, nextAction: null, citations: [] as [], confidence: null, uncertainty: 'high' as const, humanReviewRequired: true as const } satisfies GroundedProviderOutput;

function sourceFor(slot: typeof groundedContextSlots[number], tenant = slot.tenant): { tenant: typeof slot.tenant; sources: GroundedSource[] } {
  const document = resolveGroundedContextSource(slot);
  return { tenant, sources: [{ citationId: randomUUID(), title: document.title, sourceIdentity: document.sourceIdentity,
    version: document.version, position: 0, content: document.content }] };
}

describe('context-complete deterministic provider runner', () => {
  it('sends only approved case facts and tenant-matched evidence, never expected labels or rationale', async () => {
    const inputs: unknown[] = [];
    const providerFactory = (log: (event: SafeProviderEvent) => void): GroundedAnalysisProvider => ({
      model: 'mock-only', async analyze(input, _signal, correlationId) {
        inputs.push(input);
        log({ event: 'ai_grounded_analysis', outcome: 'success', correlationId, latencyMs: 10 });
        return { output: abstention, metrics: { latencyMs: 10, promptTokens: 4, generatedTokens: 5 } };
      },
    });
    const slots = groundedContextSlots.map((slot, index) => index === 0 ? { ...slot,
      expected: { category: 'incident' as const, priority: 'high' as const, recommendedTeam: 'Platform support' as const,
        nextAction: 'Review the synthetic service impact and incident timeline.' as const },
      reviewRationale: privateLabel } : slot);
    const run = await runGroundedContextEvaluation({ providerFactory, healthCheck: async () => true, sourcesFor: sourceFor, slots });
    expect(run.attempts).toHaveLength(6);
    expect(inputs).toHaveLength(6);
    expect(inputs[0]).toMatchObject({ caseFacts: groundedContextSlots[0]!.caseFacts, caseType: groundedContextSlots[0]!.caseId });
    expect(JSON.stringify(inputs)).not.toContain(privateLabel);
    expect(JSON.stringify(inputs)).not.toContain('reviewRationale');
    expect(Object.keys(inputs[0] as Record<string, unknown>).sort()).toEqual(['caseFacts', 'caseStatus', 'caseType', 'sources']);
    expect(run.observations.every((item) => item.groundingState === 'INSUFFICIENT_EVIDENCE')).toBe(true);
  });

  it('fails closed before provider invocation when essential facts are missing', async () => {
    const provider = vi.fn();
    const slots = groundedContextSlots.map((slot, index) => index === 0 ? { ...slot, caseFacts: '' } : slot);
    await expect(runGroundedContextEvaluation({ providerFactory: () => ({ model: 'mock', analyze: provider }),
      healthCheck: async () => true, sourcesFor: sourceFor, slots })).rejects.toThrow(/facts are missing/);
    expect(provider).not.toHaveBeenCalled();
  });

  it('rejects cross-tenant source bundles before invoking the provider', async () => {
    const provider = vi.fn();
    await expect(runGroundedContextEvaluation({ providerFactory: () => ({ model: 'mock', analyze: provider }),
      healthCheck: async () => true, sourcesFor: (slot) => sourceFor(slot, slot.tenant === 'north' ? 'south' : 'north') }))
      .rejects.toThrow(/source tenant/);
    expect(provider).not.toHaveBeenCalled();
  });

  it('rejects a wrong source identity or version even when the tenant matches', async () => {
    const provider = vi.fn();
    await expect(runGroundedContextEvaluation({ providerFactory: () => ({ model: 'mock', analyze: provider }),
      healthCheck: async () => true, sourcesFor: (slot) => ({ tenant: slot.tenant, sources: [
        { ...sourceFor(slot).sources[0]!, sourceIdentity: 'SYNTHETIC-NORTH-MFA-GUIDANCE' },
      ] }) })).rejects.toThrow(/source tenant/);
    await expect(runGroundedContextEvaluation({ providerFactory: () => ({ model: 'mock', analyze: provider }),
      healthCheck: async () => true, sourcesFor: (slot) => ({ tenant: slot.tenant, sources: [
        { ...sourceFor(slot).sources[0]!, version: 2 },
      ] }) })).rejects.toThrow(/source tenant/);
    expect(provider).not.toHaveBeenCalled();
  });

  it('does not retry a failed planned slot and leaves later slots unattempted after provider failure', async () => {
    const provider = vi.fn(async () => { throw new Error(privateLabel); });
    const run = await runGroundedContextEvaluation({ providerFactory: () => ({ model: 'mock', analyze: provider }),
      healthCheck: async () => true, sourcesFor: sourceFor });
    expect(provider).toHaveBeenCalledOnce();
    expect(run.attempts[0]?.status).toBe('failure');
    expect(run.attempts.slice(1).every((attempt) => attempt.status === 'not_attempted')).toBe(true);
    expect(JSON.stringify(run)).not.toContain(privateLabel);
  });
});

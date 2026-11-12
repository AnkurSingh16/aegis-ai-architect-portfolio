import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { parseGroundedProviderOutput, groundedAnalysisSchema, type GroundedProviderOutput, type GroundedSource } from '../grounded-analysis.js';
import { createGroundedOllamaProvider, createGroundedOllamaTokenBudgetEvaluationProvider, createGroundedOllamaConfidenceContractEvaluationProvider,
  createGroundedOllamaSupportedDecisionEvaluationProvider } from '../grounded-provider.js';
import type { OllamaConfig } from '../provider.js';
import { groundedBalancedScenarios } from './grounded-balanced-dataset.js';
import { runGroundedBalancedEvaluation } from './grounded-balanced-runner.js';

const config: OllamaConfig = { model: 'qwen2.5:3b-instruct', timeoutMs: 15000, maxConcurrent: 1 };
const citationId = '11111111-1111-4111-8111-111111111111';
const source: GroundedSource = { citationId, title: 'Synthetic evidence', sourceIdentity: 'EVAL-SOURCE-1', version: 1,
  position: 0, content: 'Synthetic source supports the complete recommendation.' };
const supported: GroundedProviderOutput = { groundingState: 'SUPPORTED', category: 'incident', priority: 'high',
  recommendedTeam: 'Platform support', rationale: 'The synthetic evidence supports this recommendation.',
  nextAction: 'Review the synthetic service impact and incident timeline.',
  citations: [citationId], confidence: 0.5, uncertainty: 'moderate', humanReviewRequired: true };
const abstention: GroundedProviderOutput = { groundingState: 'INSUFFICIENT_EVIDENCE', category: null, priority: null, recommendedTeam: null,
  rationale: null, nextAction: null, citations: [], confidence: null, uncertainty: 'high', humanReviewRequired: true };
const decisionGuidance = 'When the case facts and retrieved sources jointly support category, priority, recommendedTeam, nextAction and a cited rationale, choose SUPPORTED. If any required decision field lacks sufficient support, choose INSUFFICIENT_EVIDENCE. Confidence and uncertainty describe the assessment; they need not appear verbatim in the source documents. Human review is always required.';
const confidenceGuidance = 'For SUPPORTED, confidence must be a JSON number between 0 and 1, inclusive, never a quoted string or null. For INSUFFICIENT_EVIDENCE, confidence must be null. Confidence is not a statistically calibrated probability. Human review is always required.';

function envelope(output: unknown): Response {
  return new Response(JSON.stringify({ done: true, done_reason: 'stop', model: config.model, response: JSON.stringify(output),
    prompt_eval_count: 20, eval_count: 30 }), { status: 200, headers: { 'content-type': 'application/json' } });
}

async function capture(factory: typeof createGroundedOllamaTokenBudgetEvaluationProvider, output: unknown = supported) {
  const fetchImpl = vi.fn().mockResolvedValue(envelope(output));
  const provider = factory(config, { fetchImpl, log: () => undefined });
  const result = await provider.analyze({ caseStatus: 'in_progress', caseType: 'login', caseFacts: 'Synthetic case facts.', sources: [source] },
    new AbortController().signal, randomUUID());
  return { fetchImpl, result, body: JSON.parse(String((fetchImpl.mock.calls[0]?.[1] as RequestInit).body)) as Record<string, unknown> };
}

describe('M4.18 supported-decision prompt isolation', () => {
  it('starts from the original M4.15 prompt and adds only the approved decision guidance', async () => {
    const production = await capture(createGroundedOllamaProvider);
    const m415 = await capture(createGroundedOllamaTokenBudgetEvaluationProvider);
    const m417 = await capture(createGroundedOllamaConfidenceContractEvaluationProvider);
    const m418 = await capture(createGroundedOllamaSupportedDecisionEvaluationProvider);

    expect(m418.body.prompt).toBe(`${String(m415.body.prompt).replace('\nUNTRUSTED_CASE_FACTS_AND_RETRIEVED_SOURCES=', `\n${decisionGuidance}\nUNTRUSTED_CASE_FACTS_AND_RETRIEVED_SOURCES=`)}`);
    expect(String(m418.body.prompt).replace(`\n${decisionGuidance}`, '')).toBe(m415.body.prompt);
    expect(m418.body.prompt).not.toContain(confidenceGuidance);
    expect(String(m417.body.prompt).replace(`\n${confidenceGuidance}`, '')).toBe(m415.body.prompt);
    expect(production.body.prompt).toBe(m415.body.prompt);
    expect(production.body.options).toEqual({ temperature: 0.1, num_predict: 256 });
    expect(m415.body.options).toEqual({ temperature: 0.1, num_predict: 512 });
    expect(m417.body.options).toEqual(m415.body.options);

    const withoutPrompt = (body: Record<string, unknown>) => { const copy = { ...body }; delete copy.prompt; return copy; };
    expect(withoutPrompt(m418.body)).toEqual(withoutPrompt(m415.body));
    expect(m418.body).toMatchObject({ model: config.model, stream: false, options: { temperature: 0.1, num_predict: 512 }, format: groundedAnalysisSchema });
    expect(m418.fetchImpl).toHaveBeenCalledTimes(1);

    const prompt = String(m418.body.prompt);
    expect(prompt).toContain('Synthetic case facts.');
    expect(prompt).toContain(source.content);
    expect(prompt).not.toContain('expectedGroundingState');
    expect(prompt).not.toContain('reviewRationale');
    expect(prompt).not.toContain('EXPECTED_LABEL_SENTINEL');
  });

  it('keeps all six distinct fixtures and sends only model-visible case/source context', async () => {
    expect(groundedBalancedScenarios).toHaveLength(6);
    expect(new Set(groundedBalancedScenarios.map((scenario) => scenario.scenarioId)).size).toBe(6);
    expect(groundedBalancedScenarios.filter((scenario) => scenario.expectedGroundingState === 'SUPPORTED')).toHaveLength(3);
    expect(groundedBalancedScenarios.filter((scenario) => scenario.expectedGroundingState === 'INSUFFICIENT_EVIDENCE')).toHaveLength(3);
    for (const scenario of groundedBalancedScenarios) {
      const fixtureSources = scenario.sources.map((item) => ({ ...item, citationId: randomUUID(), position: 0 }));
      const mockedOutput = scenario.expected === null ? abstention : { ...supported, ...scenario.expected,
        citations: [fixtureSources[0]!.citationId] };
      const fetchImpl = vi.fn().mockResolvedValue(envelope(mockedOutput));
      const provider = createGroundedOllamaSupportedDecisionEvaluationProvider(config, { fetchImpl, log: () => undefined });
      await provider.analyze({ caseStatus: 'in_progress', caseType: scenario.caseType, caseFacts: scenario.caseFacts,
        sources: fixtureSources }, new AbortController().signal, randomUUID());
      const body = JSON.parse(String((fetchImpl.mock.calls[0]?.[1] as RequestInit).body)) as { prompt: string };
      const encodedContext = body.prompt.split('\nUNTRUSTED_CASE_FACTS_AND_RETRIEVED_SOURCES=')[1];
      expect(encodedContext).toBeDefined();
      const context = JSON.parse(encodedContext ?? '{}') as Record<string, unknown>;
      expect(Object.keys(context).sort()).toEqual(['caseFacts', 'caseType', 'sources', 'status']);
      expect(context.caseFacts).toBe(scenario.caseFacts);
      expect(context.sources).toEqual(fixtureSources.map(({ citationId, title, version, content }) => ({ citationId, title, version, content })));
      expect(body.prompt).not.toContain('expectedGroundingState');
      expect(body.prompt).not.toContain('expectedSourceIdentities');
      expect(body.prompt).not.toContain('reviewRationale');
    }
  });

  it('runs one sequential mocked request per distinct scenario with no retries', async () => {
    let active = 0;
    let maxActive = 0;
    const requestedCaseFacts: string[] = [];
    const fetchImpl = vi.fn(async (_input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      try {
        await new Promise((resolve) => setTimeout(resolve, 1));
        const body = JSON.parse(String(init?.body)) as { prompt: string };
        const context = JSON.parse(body.prompt.split('\nUNTRUSTED_CASE_FACTS_AND_RETRIEVED_SOURCES=')[1] ?? '{}') as {
          caseFacts: string; sources: Array<{ citationId: string }>;
        };
        requestedCaseFacts.push(context.caseFacts);
        const scenario = groundedBalancedScenarios.find((item) => item.caseFacts === context.caseFacts);
        if (!scenario) throw new Error('Unexpected synthetic case context.');
        const output = scenario.expected === null ? abstention : { ...supported, ...scenario.expected,
          citations: context.sources.slice(0, 1).map((item) => item.citationId) };
        return envelope(output);
      } finally {
        active -= 1;
      }
    });
    const run = await runGroundedBalancedEvaluation({
      providerFactory: (log) => createGroundedOllamaSupportedDecisionEvaluationProvider(config, { fetchImpl, log }),
      healthCheck: async () => true,
      sourcesFor: (scenario) => ({ tenant: scenario.tenant, sources: scenario.sources.map((item) => ({ ...item,
        citationId: randomUUID(), position: 0 })) }),
    });

    expect(fetchImpl).toHaveBeenCalledTimes(6);
    expect(maxActive).toBe(1);
    expect(requestedCaseFacts).toEqual(groundedBalancedScenarios.map((scenario) => scenario.caseFacts));
    expect(new Set(requestedCaseFacts).size).toBe(6);
    expect(run.attempts).toHaveLength(6);
    expect(run.attempts.every((attempt) => attempt.status === 'success')).toBe(true);
  });

  it('does not retry a failed provider request', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('synthetic mocked transport failure'));
    const run = await runGroundedBalancedEvaluation({
      providerFactory: (log) => createGroundedOllamaSupportedDecisionEvaluationProvider(config, { fetchImpl, log }),
      healthCheck: async () => true,
      sourcesFor: (scenario) => ({ tenant: scenario.tenant, sources: scenario.sources.map((item) => ({ ...item,
        citationId: randomUUID(), position: 0 })) }),
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(run.attempts[0]).toMatchObject({ scenarioId: groundedBalancedScenarios[0]!.scenarioId, status: 'failure' });
    expect(run.attempts.slice(1).every((attempt) => attempt.status === 'not_attempted')).toBe(true);
  });

  it('rejects a cross-tenant source bundle before any mocked provider call', async () => {
    const providerFactory = vi.fn();
    await expect(runGroundedBalancedEvaluation({
      providerFactory,
      healthCheck: async () => true,
      sourcesFor: (scenario) => ({ tenant: scenario.tenant === 'north' ? 'south' : 'north', sources: scenario.sources.map((item) => ({
        citationId: randomUUID(), title: item.title, sourceIdentity: item.sourceIdentity, version: item.version, position: 0, content: item.content })) }),
      onProgress: async () => undefined,
    })).rejects.toThrow(/source boundary/);
    expect(providerFactory).not.toHaveBeenCalled();
  });

  it('accepts complete supported outputs and still accepts strict abstentions', async () => {
    expect((await capture(createGroundedOllamaSupportedDecisionEvaluationProvider)).result.output).toEqual(supported);
    expect((await capture(createGroundedOllamaSupportedDecisionEvaluationProvider, abstention)).result.output).toEqual(abstention);
  });

  it('keeps confidence, citation membership, and human review validation authoritative', async () => {
    for (const invalid of [
      { ...supported, confidence: 1.01 },
      { ...supported, confidence: '0.5' },
      { ...supported, humanReviewRequired: false },
      { ...supported, citations: [randomUUID()] },
      { ...supported, citations: [citationId, citationId] },
      { ...supported, citations: [] },
      { ...abstention, confidence: 0.2 },
    ]) {
      expect(() => parseGroundedProviderOutput(invalid, [source])).toThrow();
    }
    expect(() => parseGroundedProviderOutput(supported, [source])).not.toThrow();
    expect(() => parseGroundedProviderOutput(abstention, [source])).not.toThrow();
  });
});

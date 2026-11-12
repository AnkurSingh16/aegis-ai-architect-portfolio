import Ajv from 'ajv';
import { mkdtemp, rm, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { groundedAnalysisSchema, parseGroundedProviderOutput, GroundedOutputError, type GroundedSource } from '../grounded-analysis.js';
import { recommendedActions } from '../analysis.js';
import { groundedBalancedScenarios } from './grounded-balanced-dataset.js';
import { reservePrivateReport } from './private-report.js';
import { resolveOllamaConfig } from '../provider.js';
import { assertNoDiagnosticProxy, verifySupportedOutputDiagnosticSource } from './run-grounded-supported-output-diagnostic-local.js';
import { createSupportedOnlySchema, createSupportedOutputDiagnosticProvider, createSupportedOutputDiagnosticReport,
  projectDiagnosticInput, runSupportedOutputDiagnostic, supportedOutputDiagnosticConfig, supportedOutputDiagnosticReportPath,
  supportedOutputDiagnosticScenarioIds, DiagnosticProviderFailure } from './grounded-supported-output-diagnostic.js';

const source: GroundedSource = { citationId: 'a1234567-b123-4123-8123-123456789abc', title: 'Synthetic source',
  sourceIdentity: 'SYNTHETIC-TEST', version: 1, position: 0, content: 'Synthetic evidence.' };
const supported = (overrides: Record<string, unknown> = {}) => ({ groundingState: 'SUPPORTED', category: 'incident', priority: 'high',
  recommendedTeam: 'Platform support', rationale: 'Review the supplied synthetic evidence.', nextAction: recommendedActions[0],
  citations: [source.citationId], confidence: 0.5, uncertainty: 'low', humanReviewRequired: true, ...overrides });
const abstention = { groundingState: 'INSUFFICIENT_EVIDENCE', category: null, priority: null, recommendedTeam: null, rationale: null,
  nextAction: null, citations: [], confidence: null, uncertainty: 'high', humanReviewRequired: true };
const supportedSchema = createSupportedOnlySchema();
const supportedValidator = new Ajv({ allErrors: true, coerceTypes: false, removeAdditional: false }).compile(supportedSchema);
const fullValidator = new Ajv({ allErrors: true, coerceTypes: false, removeAdditional: false }).compile(groundedAnalysisSchema);
const validSupported = (value: unknown): boolean => supportedValidator(value) === true;
const fullSchema = (value: unknown): boolean => fullValidator(value) === true;

describe('M4.22 forced SUPPORTED structural diagnostic', () => {
  it('fixes exactly the three reviewed supported scenario IDs and projects only model-visible case/source fields', () => {
    expect(supportedOutputDiagnosticScenarioIds).toEqual(['BALANCED-LOGIN-201', 'BALANCED-BILLING-301', 'BALANCED-GUIDANCE-401']);
    expect(groundedBalancedScenarios.filter((s) => supportedOutputDiagnosticScenarioIds.includes(s.scenarioId as never))).toHaveLength(3);
    const input = projectDiagnosticInput(groundedBalancedScenarios[0]!);
    expect(input).not.toHaveProperty('expected');
    expect(input).not.toHaveProperty('expectedGroundingState');
    expect(input).not.toHaveProperty('reviewRationale');
  });

  it('derives only the SUPPORTED branch without mutating the existing oneOf schema', () => {
    expect(groundedAnalysisSchema.oneOf).toHaveLength(2);
    expect(supportedSchema).toEqual(groundedAnalysisSchema.oneOf[0]);
    expect(validSupported(supported())).toBe(true);
    expect(validSupported(abstention)).toBe(false);
    expect(fullSchema(supported())).toBe(true);
    const reversed = { oneOf: [...groundedAnalysisSchema.oneOf].reverse() } as unknown as typeof groundedAnalysisSchema;
    expect(() => createSupportedOnlySchema(reversed)).toThrow('supported_schema_unavailable');
  });

  it.each([0, 0.5, 1])('accepts finite supported confidence %s', (confidence) => {
    expect(validSupported(supported({ confidence }))).toBe(true);
    expect(parseGroundedProviderOutput(supported({ confidence }), [source])).toMatchObject({ confidence });
  });

  it.each([1.01, -0.01, '0.5', null, undefined, Number.NaN, Number.POSITIVE_INFINITY])('rejects invalid supported confidence %s', (confidence) => {
    const value = supported({ confidence });
    expect(validSupported(value)).toBe(false);
    expect(() => parseGroundedProviderOutput(value, [source])).toThrow(GroundedOutputError);
  });

  it('rejects citations that are absent, duplicated, unknown, malformed, or cross-tenant input', async () => {
    for (const citations of [[], [source.citationId, source.citationId], ['b1234567-b123-4123-8123-123456789abc'], ['not-a-uuid']]) {
      expect(() => parseGroundedProviderOutput(supported({ citations }), [source])).toThrow(GroundedOutputError);
    }
    const scenario = groundedBalancedScenarios[0]!;
    const badProvider = { model: supportedOutputDiagnosticConfig.model,
      analyze: vi.fn(async () => ({ output: supported() as never, schemaAccepted: true, jsonParsed: true as const,
        metrics: { latencyMs: 1, promptTokens: null, generatedTokens: null } })) };
    const changedTenant = { ...scenario, tenant: 'south' as const };
    await expect(runSupportedOutputDiagnostic({ provider: badProvider, validateSchema: validSupported, scenarios: [changedTenant,
      groundedBalancedScenarios[2]!, groundedBalancedScenarios[4]!] })).rejects.toThrow('canonical_fixture_invalid');
  });

  it('requires human review and rejects incorrect state/field combinations', () => {
    expect(validSupported(supported({ humanReviewRequired: false }))).toBe(false);
    expect(() => parseGroundedProviderOutput(supported({ humanReviewRequired: false }), [source])).toThrow();
    expect(validSupported(abstention)).toBe(false);
    expect(fullSchema(abstention)).toBe(true);
  });

  it('pins the runtime budget and local-only route', () => {
    expect(supportedOutputDiagnosticConfig).toEqual({ model: 'qwen2.5:3b-instruct', endpoint: 'http://127.0.0.1:11434/api/generate',
      numPredict: 512, temperature: 0.1, timeoutMs: 15000, maxConcurrent: 1, maxAttempts: 3, retryCount: 0 });
    expect(() => createSupportedOutputDiagnosticProvider({ model: 'remote', timeoutMs: 15000, maxConcurrent: 1 },
      { fetchImpl: vi.fn(), beforeRequest: vi.fn() })).toThrow();
    expect(() => resolveOllamaConfig({ NODE_ENV: 'development', AEGIS_AI_ENABLED: 'true', AEGIS_OLLAMA_MODEL: 'qwen2.5:3b-instruct',
      HTTP_PROXY: 'configured' })).toThrow();
    expect(() => resolveOllamaConfig({ NODE_ENV: 'development', AEGIS_AI_ENABLED: 'true', AEGIS_OLLAMA_MODEL: 'qwen2.5:3b-instruct',
      NODE_OPTIONS: '--use-env-proxy' })).toThrow();
    for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']) {
      expect(() => assertNoDiagnosticProxy({ [key]: 'configured' })).toThrow('proxy_configuration_not_allowed');
    }
    expect(() => assertNoDiagnosticProxy({ NODE_USE_ENV_PROXY: 'true' })).toThrow('proxy_configuration_not_allowed');
    expect(() => assertNoDiagnosticProxy({}, ['--use-env-proxy'])).toThrow('proxy_configuration_not_allowed');
  });

  it('uses mocked provider transport with strict schema, fixed body settings, and no label or rationale leakage', async () => {
    const scenario = groundedBalancedScenarios[0]!;
    const input = projectDiagnosticInput(scenario);
    let captured = '';
    const socketGuard = vi.fn();
    const fetchImpl = vi.fn(async (_url: Request | URL | string, init?: RequestInit) => {
      captured = String(init?.body ?? '');
      const request = JSON.parse(captured) as { model: string; prompt: string; format: unknown; options: Record<string, unknown> };
      expect(request.model).toBe('qwen2.5:3b-instruct');
      expect(request.format).toEqual(supportedSchema);
      expect(request.options).toEqual({ temperature: 0.1, num_predict: 512 });
      const embedded = request.prompt.split('UNTRUSTED_CASE_FACTS_AND_RETRIEVED_SOURCES=')[1]!;
      const promptInput = JSON.parse(embedded) as { sources: Array<{ citationId: string }> };
      const output = supported({ citations: [promptInput.sources[0]!.citationId] });
      return new Response(JSON.stringify({ done: true, model: request.model, response: JSON.stringify(output), prompt_eval_count: 44, eval_count: 30 }));
    });
    const provider = createSupportedOutputDiagnosticProvider({ model: 'qwen2.5:3b-instruct', timeoutMs: 15000, maxConcurrent: 1 },
      { fetchImpl, beforeRequest: socketGuard });
    const result = await provider.analyze(input, new AbortController().signal, 'corr');
    expect(result.output.groundingState).toBe('SUPPORTED');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(socketGuard).toHaveBeenCalledTimes(1);
    expect(captured).not.toContain(scenario.reviewRationale);
    expect(captured).not.toContain(JSON.stringify(scenario.expected));
    expect(captured).not.toContain('expectedGroundingState');
  });

  it('caps envelope/output bytes and reports no retries after failure', async () => {
    const fetchImpl = vi.fn(async () => new Response('x'.repeat(9000)));
    const provider = createSupportedOutputDiagnosticProvider({ model: 'qwen2.5:3b-instruct', timeoutMs: 15000, maxConcurrent: 1 },
      { fetchImpl, beforeRequest: () => undefined });
    await expect(provider.analyze(projectDiagnosticInput(groundedBalancedScenarios[0]!), new AbortController().signal, 'c')).rejects.toThrow();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('rejects cross-tenant source inputs before making a provider request', async () => {
    const fetchImpl = vi.fn();
    const provider = createSupportedOutputDiagnosticProvider({ model: 'qwen2.5:3b-instruct', timeoutMs: 15000, maxConcurrent: 1 },
      { fetchImpl, beforeRequest: () => undefined });
    const input = projectDiagnosticInput(groundedBalancedScenarios[0]!);
    const tampered = { ...input, sources: input.sources.map((item, index) => index === 0 ? { ...item, tenant: 'south' as const } : item) };
    await expect(provider.analyze(tampered, new AbortController().signal, 'c')).rejects.toMatchObject({
      stage: 'input_validation', constructor: DiagnosticProviderFailure,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('bounds model output independently of the envelope size', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ done: true, model: 'qwen2.5:3b-instruct',
      response: JSON.stringify(supported({ rationale: 'x'.repeat(5000) })) })));
    const provider = createSupportedOutputDiagnosticProvider({ model: 'qwen2.5:3b-instruct', timeoutMs: 15000, maxConcurrent: 1 },
      { fetchImpl, beforeRequest: () => undefined });
    await expect(provider.analyze(projectDiagnosticInput(groundedBalancedScenarios[0]!), new AbortController().signal, 'c')).rejects.toThrow();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('honors cancellation and does not retry a timed out request', async () => {
    vi.useFakeTimers();
    try {
      const fetchImpl = vi.fn((_input: Request | URL | string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
      }));
      const provider = createSupportedOutputDiagnosticProvider({ model: 'qwen2.5:3b-instruct', timeoutMs: 15000, maxConcurrent: 1 },
        { fetchImpl, beforeRequest: () => undefined });
      const result = expect(provider.analyze(projectDiagnosticInput(groundedBalancedScenarios[0]!), new AbortController().signal, 'c'))
        .rejects.toThrow();
      await vi.advanceTimersByTimeAsync(15000);
      await result;
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    } finally { vi.useRealTimers(); }
  });

  it('runs at most three ordered attempts sequentially and keeps decision quality not rated', async () => {
    const active = { value: 0, max: 0 };
    const provider = { model: 'qwen2.5:3b-instruct', async analyze() {
      active.value++;
      active.max = Math.max(active.max, active.value);
      await Promise.resolve();
      active.value--;
      return { output: supported() as never, schemaAccepted: true, jsonParsed: true as const,
        metrics: { latencyMs: 2, promptTokens: null, generatedTokens: null } };
    } };
    const scenarios = [0, 2, 4].map((index) => groundedBalancedScenarios[index]!);
    const outcomes = await runSupportedOutputDiagnostic({ provider, validateSchema: validSupported, scenarios });
    const sourceIdentity = { codeCommit: 'a'.repeat(40), treeHash: 'b'.repeat(40), sourceRef: 'origin/main', reviewedRefCommit: 'c'.repeat(40) };
    const report = createSupportedOutputDiagnosticReport({ source: sourceIdentity, outcomes });
    expect(outcomes).toHaveLength(3);
    expect(active.max).toBe(1);
    expect(report.decisionQualityStatus).toBe('NOT_RATED');
    expect(report.naturalSupportedCoverage).toBeNull();
    expect(JSON.stringify(report)).not.toContain('Review the supplied synthetic evidence.');
    const changedLabels = scenarios.map((scenario) => ({ ...scenario, expected: { category: 'wrong', priority: 'wrong',
      recommendedTeam: 'wrong', nextAction: 'wrong' } as never }));
    const afterLabelChange = await runSupportedOutputDiagnostic({ provider, validateSchema: validSupported, scenarios: changedLabels });
    expect(afterLabelChange.map((item) => item.classificationFieldAgreement)).toEqual(outcomes.map((item) => item.classificationFieldAgreement));
    const unsafe = { ...outcomes[0]!, rawResponse: 'sensitive mock output', prompt: 'private prompt' } as typeof outcomes[number];
    const sanitized = createSupportedOutputDiagnosticReport({ source: sourceIdentity, outcomes: [unsafe, ...outcomes.slice(1)] });
    expect(JSON.stringify(sanitized)).not.toContain('sensitive mock output');
    expect(JSON.stringify(sanitized)).not.toContain('private prompt');
    expect(() => createSupportedOutputDiagnosticReport({ source: sourceIdentity, outcomes: [outcomes[0]!, outcomes[0]!, outcomes[2]!] }))
      .toThrow('invalid_report_outcomes');
  });

  it('does not retry failures and remains limited to the three fixed scenarios', async () => {
    const provider = { model: 'qwen2.5:3b-instruct', analyze: vi.fn(async () => { throw new Error('safe mock failure'); }) };
    const outcomes = await runSupportedOutputDiagnostic({ provider, validateSchema: validSupported });
    expect(provider.analyze).toHaveBeenCalledTimes(3);
    expect(outcomes.map((outcome) => outcome.scenarioId)).toEqual(supportedOutputDiagnosticScenarioIds);
    expect(outcomes.every((outcome) => outcome.requestStatus === 'failed')).toBe(true);
  });

  it('reserves a private test report exclusively and leaves the real future path untouched', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'm422-report-'));
    const path = join(directory, 'reports', 'diagnostic.json');
    try {
      const handle = await reservePrivateReport(path);
      await handle.close();
      expect((await lstat(path)).mode & 0o777).toBe(0o600);
      await expect(reservePrivateReport(path)).rejects.toThrow();
      expect(supportedOutputDiagnosticReportPath).toBe('.local/evaluations/milestone-4.22-grounded-supported-output-diagnostic-qwen2.5-3b-instruct-v1.json');
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it('requires clean synchronized merged main, reviewed tree identity, and approved base ancestry', () => {
    const commit = 'a'.repeat(40);
    const tree = 'b'.repeat(40);
    const reviewed = 'c'.repeat(40);
    const fakeGit = (overrides: Record<string, string> = {}) => (args: readonly string[]): string => {
      const key = args.join(' ');
      const values: Record<string, string> = {
        'branch --show-current': 'main', 'status --porcelain=v1': '', 'rev-parse HEAD': commit,
        'rev-parse HEAD^{tree}': tree, 'rev-parse origin/main': commit, 'rev-parse origin/main^{tree}': tree,
        'rev-parse origin/feat/m4-grounded-supported-output-diagnostic^{tree}': tree,
        'rev-parse origin/feat/m4-grounded-supported-output-diagnostic': reviewed,
        ['merge-base --is-ancestor 976856cc9eea8b4195712a3c73b4e82730cef5e5 ' + commit]: '', ...overrides,
      };
      if (!(key in values)) throw new Error('unexpected_git_read');
      if (values[key] === '!throw') throw new Error('guard_rejected');
      return values[key]!;
    };
    expect(verifySupportedOutputDiagnosticSource(fakeGit())).toMatchObject({ codeCommit: commit, treeHash: tree, reviewedRefCommit: reviewed });
    expect(() => verifySupportedOutputDiagnosticSource(fakeGit({ 'branch --show-current': 'feature' }))).toThrow('source_not_clean_merged_main');
    expect(() => verifySupportedOutputDiagnosticSource(fakeGit({ 'status --porcelain=v1': ' M file' }))).toThrow('source_not_clean_merged_main');
    expect(() => verifySupportedOutputDiagnosticSource(fakeGit({ 'rev-parse origin/main': 'd'.repeat(40) }))).toThrow('main_not_synchronized');
    expect(() => verifySupportedOutputDiagnosticSource(fakeGit({ 'rev-parse origin/feat/m4-grounded-supported-output-diagnostic^{tree}': 'd'.repeat(40) })))
      .toThrow('reviewed_tree_mismatch');
    expect(() => verifySupportedOutputDiagnosticSource(fakeGit({ ['merge-base --is-ancestor 976856cc9eea8b4195712a3c73b4e82730cef5e5 ' + commit]: '!throw' })))
      .toThrow('guard_rejected');
  });
});

import Ajv from 'ajv';
import { createHash } from 'node:crypto';
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
      const promptInput = JSON.parse(embedded) as { caseStatus: string; status?: string; sources: Array<{ citationId: string }> };
      expect(promptInput.caseStatus).toBe('in_progress');
      expect(promptInput).not.toHaveProperty('status');
      expect(request.prompt).toContain('attempt a SUPPORTED-shaped response only when case facts and retrieved sources support every required recommendation field');
      expect(request.prompt).toContain('the evaluator records it as a diagnostic failure and never repairs it');
      expect(request.prompt).not.toMatch(/\babstain\b/i);
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
    expect(outcomes.every((item) => item.citationIdentityValid === true)).toBe(true);
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

  it('keeps schema and parser acceptance separate for a parser-accepted abstention under the forced schema', async () => {
    const provider = { model: 'qwen2.5:3b-instruct', async analyze() {
      return { output: abstention as never, schemaAccepted: false, jsonParsed: true as const,
        metrics: { latencyMs: 1, promptTokens: null, generatedTokens: null } };
    } };
    const [outcome] = await runSupportedOutputDiagnostic({ provider, validateSchema: validSupported });
    expect(outcome).toMatchObject({ jsonParseAccepted: true, schemaAccepted: false, parserAccepted: true,
      citationIdentityValid: null, confidenceValidation: 'not_reached' });
  });

  it('records an observed request-scoped citation failure as false without saving output details', async () => {
    const fetchImpl = vi.fn(async (_url: Request | URL | string, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as { prompt: string; model: string };
      return new Response(JSON.stringify({ done: true, model: request.model,
        response: JSON.stringify(supported({ citations: ['b1234567-b123-4123-8123-123456789abc'] })), eval_count: 9 }));
    });
    const provider = createSupportedOutputDiagnosticProvider({ model: 'qwen2.5:3b-instruct', timeoutMs: 15000, maxConcurrent: 1 },
      { fetchImpl, beforeRequest: () => undefined });
    const [outcome] = await runSupportedOutputDiagnostic({ provider, validateSchema: validSupported });
    expect(outcome).toMatchObject({ jsonParseAccepted: true, schemaAccepted: true, parserAccepted: false,
      citationIdentityValid: false, validationReason: 'unknown_citation' });
    expect(JSON.stringify(outcome)).not.toContain('b1234567-b123-4123-8123-123456789abc');
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('classifies a direct parser citation error as a failed parser check', async () => {
    const provider = { model: 'qwen2.5:3b-instruct', async analyze() {
      throw new GroundedOutputError('invalid_citations', 'duplicate_citation');
    } };
    const [outcome] = await runSupportedOutputDiagnostic({ provider, validateSchema: validSupported });
    expect(outcome).toMatchObject({ parserAccepted: false, citationIdentityValid: false, validationReason: 'duplicate_citation' });
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

  it('accepts synchronized post-M4.23 main when the reviewed M4.22 and M4.23 source blobs remain pinned', () => {
    const commit = '8'.repeat(40);
    const tree = '9'.repeat(40);
    const reviewedGuardCommit = 'd'.repeat(40);
    const m422 = '3fe57fd8a366b4532a440222355de0a5b3821c1d';
    const m423 = '59cb95f32389ae1ed2fd6715f1e0e983bffb6b0c';
    const m422Tree = '79d0a6a50a59880a16a0f2294475686ccfe89872';
    const m423Tree = '7dfb48eaa27f7ae0b3cdb36f66d143655af46d84';
    const m422Feature = '536f702f8423824479bd77145c7031856ec5a069';
    const m423Feature = 'a543dab169265754bfe38252abd47c6d98fc3d63';
    const m422Paths: Record<string, string> = {
      'apps/api/src/ai/evaluation/grounded-supported-output-diagnostic.ts': '7bce941f7f59e5d9b1bd1f9c66ed1bb2a27e8b36',
      'apps/api/src/ai/grounded-analysis.ts': 'e39dff2024fc1ca593d54a4e96f0a8644ef64c02',
      'apps/api/src/ai/evaluation/grounded-balanced-dataset.ts': 'a4c3ed5dd2f35d2628dc5319a402da873db96217',
      'apps/api/src/ai/grounded-provider.ts': 'e2a7b76d059f0c2538f1b095e54df08eea99a4e4',
      'apps/api/src/ai/provider.ts': 'dc8dc7be163ee454771fdc188632ea396d4c022d',
      'apps/api/src/ai/evaluation/private-report.ts': '2514348183e39e5411a2ddfb0b90a4394140068c',
    };
    const socketPath = 'apps/api/src/ai/evaluation/ollama-socket-preflight.ts';
    const socketBlob = 'c7c37967915bfcccd47c21150ca7ca0996667767';
    const runnerPath = 'apps/api/src/ai/evaluation/run-grounded-supported-output-diagnostic-local.ts';
    const testPath = 'apps/api/src/ai/evaluation/grounded-supported-output-diagnostic.test.ts';
    const baselineRunner = 'prefix\nexport function verifySupportedOutputDiagnosticSource(readGit: unknown) { return "original"; }\nfunction assertNoOtherClient() {}\nsuffix';
    const currentRunner = 'prefix\nexport function verifySupportedOutputDiagnosticSource(readGit: unknown) { return "narrow identity gate"; }\nfunction assertNoOtherClient() {}\nsuffix';
    const testBlob = 'f'.repeat(40);
    const gitBlobId = (value: string): string => {
      const bytes = Buffer.from(value, 'utf8');
      return createHash('sha1').update(`blob ${bytes.byteLength}\0`).update(bytes).digest('hex');
    };
    const baselineRunnerBlob = gitBlobId(baselineRunner);
    const gateBlob = gitBlobId(currentRunner);
    const fakeGit = (extra: Record<string, string> = {}) => (args: readonly string[]): string => {
      const key = args.join(' ');
      const values: Record<string, string> = {
        'branch --show-current': 'main', 'status --porcelain=v1': '',
        'rev-parse HEAD': commit, 'rev-parse HEAD^{tree}': tree,
        'rev-parse origin/main': commit, 'rev-parse origin/main^{tree}': tree,
        [`rev-parse ${m422}^{tree}`]: m422Tree, [`rev-parse ${m423}^{tree}`]: m423Tree,
        [`rev-parse origin/feat/m4-grounded-supported-output-diagnostic`]: m422Feature,
        [`rev-parse origin/feat/m4-grounded-supported-output-diagnostic^{tree}`]: m422Tree,
        [`rev-parse origin/fix/m423-ollama-closed-socket-preflight`]: m423Feature,
        [`rev-parse origin/fix/m423-ollama-closed-socket-preflight^{tree}`]: m423Tree,
        [`merge-base --is-ancestor ${m422} ${commit}`]: '',
        [`merge-base --is-ancestor ${m423} ${commit}`]: '',
        [`diff --name-only ${m423}..HEAD`]: `${testPath}\n${runnerPath}`,
        [`show ${m422}:${runnerPath}`]: baselineRunner,
        [`show HEAD:${runnerPath}`]: currentRunner,
        'rev-parse origin/fix/m4.22-source-identity-gate': reviewedGuardCommit,
        [`rev-parse HEAD:${runnerPath}`]: gitBlobId(currentRunner),
        [`rev-parse ${m422}:${runnerPath}`]: baselineRunnerBlob,
        [`rev-parse origin/feat/m4-grounded-supported-output-diagnostic:${runnerPath}`]: baselineRunnerBlob,
        [`rev-parse origin/fix/m4.22-source-identity-gate:${runnerPath}`]: gateBlob,
        [`rev-parse HEAD:${testPath}`]: testBlob,
        [`rev-parse origin/fix/m4.22-source-identity-gate:${testPath}`]: testBlob,
        [`ls-remote origin refs/heads/main refs/heads/feat/m4-grounded-supported-output-diagnostic refs/heads/fix/m423-ollama-closed-socket-preflight refs/heads/fix/m4.22-source-identity-gate`]:
          `${commit}\trefs/heads/main\n${m422Feature}\trefs/heads/feat/m4-grounded-supported-output-diagnostic\n${m423Feature}\trefs/heads/fix/m423-ollama-closed-socket-preflight\n${reviewedGuardCommit}\trefs/heads/fix/m4.22-source-identity-gate`,
        ...extra,
      };
      for (const [path, blob] of Object.entries(m422Paths)) {
        values[`rev-parse ${m422}:${path}`] = blob;
        values[`rev-parse origin/feat/m4-grounded-supported-output-diagnostic:${path}`] = blob;
        if (path !== runnerPath) values[`rev-parse HEAD:${path}`] = blob;
      }
      values[`rev-parse HEAD:${socketPath}`] = socketBlob;
      values[`rev-parse ${m423}:${socketPath}`] = socketBlob;
      values[`rev-parse origin/fix/m423-ollama-closed-socket-preflight:${socketPath}`] = socketBlob;
      Object.assign(values, extra);
      if (!(key in values) || values[key] === '!throw') throw new Error('mock_git_failure');
      return values[key]!;
    };

    expect(verifySupportedOutputDiagnosticSource(fakeGit())).toMatchObject({ codeCommit: commit, treeHash: tree,
      sourceRef: 'origin/main', reviewedRefCommit: reviewedGuardCommit });

    expect(() => verifySupportedOutputDiagnosticSource(fakeGit({
      [`rev-parse HEAD:apps/api/src/ai/evaluation/grounded-supported-output-diagnostic.ts`]: '1'.repeat(40),
    }))).toThrow('reviewed_source_blob_mismatch');
    expect(() => verifySupportedOutputDiagnosticSource(fakeGit({ [`rev-parse HEAD:${socketPath}`]: '2'.repeat(40) })))
      .toThrow('reviewed_source_blob_mismatch');
    expect(() => verifySupportedOutputDiagnosticSource(fakeGit({ 'status --porcelain=v1': ' M source.ts' })))
      .toThrow('source_not_clean_merged_main');
    expect(() => verifySupportedOutputDiagnosticSource(fakeGit({ 'rev-parse origin/main': '3'.repeat(40) })))
      .toThrow('main_not_synchronized');
    expect(() => verifySupportedOutputDiagnosticSource(fakeGit({
      [`ls-remote origin refs/heads/main refs/heads/feat/m4-grounded-supported-output-diagnostic refs/heads/fix/m423-ollama-closed-socket-preflight refs/heads/fix/m4.22-source-identity-gate`]:
        `${'4'.repeat(40)}\trefs/heads/main`,
    }))).toThrow('live_source_refs_mismatch');
    expect(() => verifySupportedOutputDiagnosticSource(fakeGit({
      'rev-parse origin/fix/m423-ollama-closed-socket-preflight': '!throw',
    }))).toThrow('approved_source_ref_missing');
    expect(() => verifySupportedOutputDiagnosticSource(fakeGit({
      [`rev-parse origin/feat/m4-grounded-supported-output-diagnostic`]: '!throw',
    }))).toThrow('approved_source_ref_missing');
    expect(() => verifySupportedOutputDiagnosticSource(fakeGit({
      'rev-parse origin/fix/m4.22-source-identity-gate': '!throw',
    }))).toThrow('approved_source_ref_missing');
    expect(() => verifySupportedOutputDiagnosticSource(fakeGit({
      [`merge-base --is-ancestor ${m423} ${commit}`]: '!throw',
    }))).toThrow('approved_release_not_ancestor');
    expect(() => verifySupportedOutputDiagnosticSource(fakeGit({
      [`show HEAD:${runnerPath}`]: `${currentRunner}\n// unreviewed runner change`,
    }))).toThrow('unreviewed_runner_changes');
    expect(() => verifySupportedOutputDiagnosticSource(fakeGit({
      [`diff --name-only ${m423}..HEAD`]: `${testPath}\n${runnerPath}\napps/api/src/ai/provider.ts`,
    }))).toThrow('unreviewed_post_release_changes');
  });
});

import { createHash, randomUUID } from 'node:crypto';
import type { GroundedAnalysisProvider, GroundedProviderOutput, GroundedSource } from '../grounded-analysis.js';
import { createBalancedObservation } from './grounded-balanced-scoring.js';
import type { BalancedAttempt } from './grounded-balanced-runner.js';
import { groundedBalancedScenarios } from './grounded-balanced-dataset.js';
import { createGroundedOllamaProvider } from '../grounded-provider.js';
import { runGroundedBalancedEvaluation } from './grounded-balanced-runner.js';
import { groundedAiQualificationV1Contract, groundedAiQualificationV1ProtectedFileSha256,
  groundedAiQualificationV1ReviewedFileSha256, groundedAiQualificationV1DatasetSha256 } from './grounded-ai-qualification-v1.js';
import type { SafeProviderEvent } from './grounded-provider-diagnostics.js';
import {
  aiAssistedExploratoryEvaluationV1Contract as contract,
  aiAssistedExploratoryEvaluationV1ReportRelativePath as reportPath,
  createAiAssistedExploratoryEvaluationV1Report,
  verifyAiAssistedExploratoryRunnerIdentity,
  type AiAssistedExploratorySourceIdentity,
} from './ai-assisted-exploratory-evaluation-v1.js';
import { chmod, lstat, mkdir, mkdtemp, readFile as readFileBytes, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { reservePrivateReport, writePrivateReport } from './private-report.js';
import { assertExploratoryReportPathAbsent, normalizedExploratoryContractHelperSha256,
  runAiAssistedExploratoryOrchestration, safeAiAssistedExploratoryFailure, verifyExploratoryContractHelperIdentity, verifyExploratoryDataset,
  validateExploratoryModelIdentity, validateExploratoryRuntime, verifyExploratoryTransport } from './run-ai-assisted-exploratory-evaluation-v1-local.js';
import type { ExploratoryOrchestrationPorts } from './run-ai-assisted-exploratory-evaluation-v1-local.js';
import type { PreparedExploratoryRun } from './run-ai-assisted-exploratory-evaluation-v1-local.js';
import { readFile } from 'node:fs/promises';

const source: AiAssistedExploratorySourceIdentity = {
  baselineCommit: groundedAiQualificationV1Contract.baselineCommit,
  m422ReleaseCommit: groundedAiQualificationV1Contract.m422ReleaseCommit,
  m423ReleaseCommit: groundedAiQualificationV1Contract.m423ReleaseCommit,
  sourceIdentityReleaseCommit: groundedAiQualificationV1Contract.sourceIdentityReleaseCommit,
  sourceIdentityReviewedHead: groundedAiQualificationV1Contract.sourceIdentityReviewedHead,
  codeCommit: '4c25c462adf1916af7ca0a41dc1a8092ac49d5f6',
  treeHash: '0'.repeat(40),
  protectedFileSha256: { ...groundedAiQualificationV1ProtectedFileSha256, ...groundedAiQualificationV1ReviewedFileSha256 },
  exploratoryRunnerSha256: contract.reviewedRunnerSha256,
  exploratoryRunnerReleaseCommit: '4c25c462adf1916af7ca0a41dc1a8092ac49d5f6',
  repositoryBaseCommit: contract.approvedBaseCommit,
};

const fixedRuntime = {
  requestLimit: 6,
  attemptsPerScenarioLimit: 1,
  concurrencyLimit: 1,
  retries: 0,
  timeoutMs: 15000,
  temperature: 0.1,
  numPredict: 256,
  loopbackEndpoint: 'http://127.0.0.1:11434/api/generate',
  cloudFallback: 'prohibited' as const,
  externalActions: 'prohibited' as const,
  humanReviewRequiredForRecommendations: true,
};

const isoStart = '2026-11-18T00:00:00.000Z';

function observations(count: number) {
  return groundedBalancedScenarios.slice(0, count).map((scenario) => createBalancedObservation(scenario, 'not_attempted'));
}

function attempts(count: number): BalancedAttempt[] {
  return groundedBalancedScenarios.slice(0, count).map((scenario) => ({ scenarioId: scenario.scenarioId,
    status: 'not_attempted', latencyMs: null, promptTokens: null, generatedTokens: null, correlationComplete: false }));
}

function createReport(count = 0) {
  return createAiAssistedExploratoryEvaluationV1Report({ status: 'in_progress', startedAt: isoStart,
    finishedAt: isoStart, ollamaVersion: contract.ollamaVersion, source, machineContract: fixedRuntime,
    attempts: attempts(count), observations: observations(count) });
}

function mockSourcesFor(scenario: typeof groundedBalancedScenarios[number]) {
  return { tenant: scenario.tenant, sources: scenario.sources.map((fixture): GroundedSource => ({
    citationId: randomUUID(), title: fixture.title, sourceIdentity: fixture.sourceIdentity,
    version: fixture.version, position: 0, content: fixture.content,
  })) };
}

function mockOutput(scenario: typeof groundedBalancedScenarios[number], sources: readonly GroundedSource[]): GroundedProviderOutput {
  if (!scenario.expected) return { groundingState: 'INSUFFICIENT_EVIDENCE', category: null, priority: null, recommendedTeam: null,
    rationale: null, nextAction: null, citations: [], confidence: null, uncertainty: 'high', humanReviewRequired: true };
  return { groundingState: 'SUPPORTED', ...scenario.expected, rationale: 'Deterministic mock fixture output.',
    citations: sources.map((item) => item.citationId), confidence: 0.5, uncertainty: 'moderate', humanReviewRequired: true };
}

function makeOrchestrationPorts(
  path: string,
  trace: string[],
  overrides: Partial<ExploratoryOrchestrationPorts> = {},
): ExploratoryOrchestrationPorts {
  const base: ExploratoryOrchestrationPorts = {
    reportPath: path,
    preflightSource: async () => { trace.push('source'); return source; },
    preflightDataset: async () => { trace.push('dataset'); verifyExploratoryDataset(); },
    preflightRuntime: async () => {
      trace.push('runtime');
      return { ollamaVersion: contract.ollamaVersion,
        providerConfig: { model: contract.model, timeoutMs: contract.timeoutMs, maxConcurrent: contract.maximumConcurrency } };
    },
    checkReportAvailable: async (report) => { trace.push('report_path'); await assertExploratoryReportPathAbsent(report); },
    preflightModel: async (prepared) => {
      trace.push('model');
      expect(prepared.providerConfig.timeoutMs).toBe(contract.timeoutMs);
      expect(prepared.providerConfig.maxConcurrent).toBe(1);
    },
    confirm: async () => { trace.push('confirm'); return true; },
    reserveReport: async (report) => {
      trace.push('reserve');
      const handle = await reservePrivateReport(report);
      return { write: (value) => writePrivateReport(handle, value), close: () => handle.close() };
    },
    providerFactory: (_prepared, emit) => {
      trace.push('provider_factory');
      return { model: 'mock-only', async analyze(input, _signal, correlationId) {
        trace.push('provider_call');
        const scenario = groundedBalancedScenarios.find((item) => item.caseFacts === input.caseFacts)!;
        emit({ event: 'ai_grounded_analysis', outcome: 'success', correlationId, latencyMs: 1 });
        return { output: mockOutput(scenario, input.sources), metrics: { latencyMs: 1, promptTokens: 8, generatedTokens: 9 } };
      } };
    },
    healthCheck: async () => true,
    sourcesFor: mockSourcesFor,
    reportHash: async (report) => createHash('sha256').update(await readFileBytes(report)).digest('hex'),
    now: () => new Date(isoStart),
    output: (value) => { trace.push(`output:${String(value.status)}`); },
    onStage: (value) => { trace.push(`stage:${value}`); },
  };
  return { ...base, ...overrides };
}

describe('AI-assisted exploratory evaluation v1 contract', () => {
  it('keeps a separate report identity and freezes the synthetic local request limits', () => {
    expect(reportPath).toBe('.local/evaluations/ai-assisted-exploratory-grounded-qwen2.5-3b-instruct-v1.json');
    expect(reportPath).not.toBe('.local/evaluations/grounded-ai-qualification-qwen2.5-3b-instruct-v1.json');
    expect(contract.maximumRequests).toBe(6);
    expect(contract.maximumConcurrency).toBe(1);
    expect(contract.maximumAttemptsPerScenario).toBe(1);
    expect(contract.retryCount).toBe(0);
    expect(contract.timeoutMs).toBe(15000);
    expect(contract.temperature).toBe(0.1);
    expect(contract.numPredict).toBe(256);
    expect(contract.endpoint).toBe('http://127.0.0.1:11434/api/generate');
    expect(contract.modelManifestDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(groundedBalancedScenarios).toHaveLength(6);
    expect(groundedBalancedScenarios.filter((scenario) => scenario.expectedGroundingState === 'SUPPORTED')).toHaveLength(3);
    expect(groundedBalancedScenarios.filter((scenario) => scenario.expectedGroundingState === 'INSUFFICIENT_EVIDENCE')).toHaveLength(3);
    expect(new Set(groundedBalancedScenarios.flatMap((scenario) => scenario.sources.map((item) => item.sourceIdentity))).size).toBe(13);
  });

  it('checks the exact canonical dataset digest and rejects a changed digest', () => {
    expect(groundedAiQualificationV1DatasetSha256()).toBe(contract.datasetSha256);
    expect(verifyExploratoryDataset).not.toThrow();
    expect(() => verifyExploratoryDataset('0'.repeat(64))).toThrow('exploratory_dataset_contract_mismatch');
  });

  it('rejects a model tag or digest mismatch and competing loaded models', () => {
    const validTags = { models: [{ name: contract.model, digest: contract.modelManifestDigest }] };
    const validPs = { models: [{ name: contract.model }] };
    expect(() => validateExploratoryModelIdentity(validTags, validPs)).not.toThrow();
    expect(() => validateExploratoryModelIdentity({ models: [{ name: 'other:3b', digest: contract.modelManifestDigest }] }, validPs))
      .toThrow('exploratory_model_unavailable');
    expect(() => validateExploratoryModelIdentity({ models: [{ name: contract.model, digest: 'sha256:' + '0'.repeat(64) }] }, validPs))
      .toThrow('exploratory_model_unavailable');
    expect(() => validateExploratoryModelIdentity(validTags, { models: [{ name: 'other:3b' }] }))
      .toThrow('exploratory_competing_model_loaded');
  });

  it('rejects runtime version, model config, concurrency, timeout, and endpoint drift', () => {
    const approved = { model: contract.model, timeoutMs: contract.timeoutMs, maxConcurrent: contract.maximumConcurrency };
    expect(() => validateExploratoryRuntime(contract.ollamaVersion, approved, contract.endpoint)).not.toThrow();
    expect(() => validateExploratoryRuntime('0.0.0', approved, contract.endpoint)).toThrow('exploratory_runtime_contract_mismatch');
    expect(() => validateExploratoryRuntime(contract.ollamaVersion, undefined, contract.endpoint)).toThrow('exploratory_runtime_contract_mismatch');
    expect(() => validateExploratoryRuntime(contract.ollamaVersion, { ...approved, model: 'other:3b' }, contract.endpoint))
      .toThrow('exploratory_runtime_contract_mismatch');
    expect(() => validateExploratoryRuntime(contract.ollamaVersion, { ...approved, timeoutMs: 1000 }, contract.endpoint))
      .toThrow('exploratory_runtime_contract_mismatch');
    expect(() => validateExploratoryRuntime(contract.ollamaVersion, { ...approved, maxConcurrent: 2 }, contract.endpoint))
      .toThrow('exploratory_runtime_contract_mismatch');
    expect(() => validateExploratoryRuntime(contract.ollamaVersion, approved, 'https://remote.invalid/generate'))
      .toThrow('exploratory_runtime_contract_mismatch');
  });

  it('requires the reviewed runner hash in both local bytes and approved release blob', async () => {
    const expectedRelease = contract.approvedBaseCommit;
    const runnerBytes = await readFile(new URL('./run-ai-assisted-exploratory-evaluation-v1-local.ts', import.meta.url));
    const actualRunnerSha256 = createHash('sha256').update(runnerBytes).digest('hex');
    expect(actualRunnerSha256).toBe(contract.reviewedRunnerSha256);
    const readGit = (args: readonly string[]) => {
      if (args[0] === 'rev-parse') return contract.approvedBaseCommit;
      if (args[0] === 'merge-base') return '';
      throw new Error('unexpected_git_read');
    };
    const readBlob = (_ref: string, path: string) => {
      expect(path).toBe('apps/api/src/ai/evaluation/run-ai-assisted-exploratory-evaluation-v1-local.ts');
      return actualRunnerSha256;
    };
    expect(verifyAiAssistedExploratoryRunnerIdentity(readGit, readBlob, expectedRelease, actualRunnerSha256))
      .toEqual({ releaseCommit: expectedRelease, runnerSha256: actualRunnerSha256 });
    expect(() => verifyAiAssistedExploratoryRunnerIdentity(readGit, readBlob, expectedRelease, 'f'.repeat(64)))
      .toThrow('exploratory_source_runner_pin_invalid');
    expect(() => verifyAiAssistedExploratoryRunnerIdentity(readGit, () => '0'.repeat(64), expectedRelease,
      contract.reviewedRunnerSha256)).toThrow('exploratory_source_runner_blob_mismatch');
    expect(() => verifyAiAssistedExploratoryRunnerIdentity(readGit, readBlob, 'not-a-release', contract.reviewedRunnerSha256))
      .toThrow('exploratory_source_release_sha_invalid');
  });

  it('pins all contract-helper bytes except the exact runner-hash field in local and release source', async () => {
    const helperBytes = await readFile(new URL('./ai-assisted-exploratory-evaluation-v1.ts', import.meta.url));
    const helperHash = normalizedExploratoryContractHelperSha256(helperBytes);
    expect(helperHash).toBe('f7ead42029fe58bacf2729495cfed8960dca84f0261242a9f268a7f5498bf4d2');
    expect(verifyExploratoryContractHelperIdentity(helperBytes, helperBytes)).toBe(helperHash);
    const altered = Buffer.from(helperBytes.toString('utf8').replace('preliminary classification critique', 'altered classification critique'));
    expect(() => verifyExploratoryContractHelperIdentity(altered, helperBytes)).toThrow('exploratory_contract_helper_hash_mismatch');
    expect(() => verifyExploratoryContractHelperIdentity(helperBytes, altered)).toThrow('exploratory_contract_helper_hash_mismatch');
    expect(() => normalizedExploratoryContractHelperSha256(Buffer.from('reviewedRunnerSha256: missing')))
      .toThrow('exploratory_contract_helper_pin_shape_invalid');
  });

  it('fails closed when the approved base ref or ancestry is missing or mismatched', () => {
    const expectedRelease = 'a'.repeat(40);
    const readBlob = () => contract.reviewedRunnerSha256;
    const missingBase = (args: readonly string[]): string => {
      if (args[0] === 'rev-parse') throw new Error('missing_ref');
      return '';
    };
    const mismatchedBase = (args: readonly string[]): string => args[0] === 'rev-parse' ? 'b'.repeat(40) : '';
    const missingAncestor = (args: readonly string[]): string => {
      if (args[0] === 'rev-parse') return contract.approvedBaseCommit;
      throw new Error('not_an_ancestor');
    };
    expect(() => verifyAiAssistedExploratoryRunnerIdentity(missingBase, readBlob, expectedRelease,
      contract.reviewedRunnerSha256)).toThrow('exploratory_source_approved_base_ref_missing');
    expect(() => verifyAiAssistedExploratoryRunnerIdentity(mismatchedBase, readBlob, expectedRelease,
      contract.reviewedRunnerSha256)).toThrow('exploratory_source_approved_base_ref_mismatch');
    expect(() => verifyAiAssistedExploratoryRunnerIdentity(missingAncestor, readBlob, expectedRelease,
      contract.reviewedRunnerSha256)).toThrow('exploratory_source_approved_base_not_ancestor');
    const wrongAncestor = (args: readonly string[]): string => {
      if (args[0] === 'rev-parse') return contract.approvedBaseCommit;
      expect(args).toEqual(['merge-base', '--is-ancestor', contract.approvedBaseCommit, expectedRelease]);
      throw new Error('release_is_not_descendant_of_approved_base');
    };
    expect(() => verifyAiAssistedExploratoryRunnerIdentity(wrongAncestor, readBlob, expectedRelease,
      contract.reviewedRunnerSha256)).toThrow('exploratory_source_approved_base_not_ancestor');
  });

  it('rejects proxies and non-loopback generation endpoints before any provider can be constructed', () => {
    expect(() => verifyExploratoryTransport({ HTTPS_PROXY: 'http://proxy.invalid' }, [], contract.endpoint))
      .toThrow('proxy_configuration_not_allowed');
    expect(() => verifyExploratoryTransport({}, ['--use-env-proxy'], contract.endpoint))
      .toThrow('proxy_configuration_not_allowed');
    expect(() => verifyExploratoryTransport({}, [], 'https://example.invalid/api/generate'))
      .toThrow('exploratory_endpoint_not_approved');
    expect(() => verifyExploratoryTransport({}, [], contract.endpoint)).not.toThrow();
  });

  it('creates a distinct report that never promotes exploratory output or human approval', () => {
    const report = createReport();
    expect(report.reportSchemaVersion).toBe('aegis-ai-assisted-exploratory-report-v1');
    expect(report.status).toBe('in_progress');
    expect(report.qualificationStatus).toBe('NOT_QUALIFIED');
    expect(report.dataset.humanApprovalStatus).toBe('NOT_VERIFIED');
    expect(report.machineContract.status).toBe('incomplete_or_failed');
    expect(report.exploratoryComparison.decisionQualityStatus).toBe('NOT_QUALIFIED');
    expect(report.exploratoryComparison.semanticEvidenceValidation).toBe('NOT_ASSESSED');
    expect(report.exploratoryComparison.categoryTaxonomyMapping).toBe('NOT_HUMAN_VERIFIED');
    expect(report.model.providerSourceSha256).toBe(source.protectedFileSha256['apps/api/src/ai/grounded-provider.ts']);
    expect(report.dataset.priorAiCritiques.provenanceStatus).toBe('reported_external_artifacts_not_independently_verified');
    expect(report.dataset.priorAiCritiques.artifacts).toHaveLength(2);
    expect(report.dataset.priorAiCritiques.artifacts[0]?.modelId).toBe('Claude Sonnet 5.5');
    expect(report.dataset.priorAiCritiques.artifacts[0]?.reportSha256)
      .toBe('f3122a058024f6cb165e041a9782feb22b13b81034ebc3f888120545ccbbbe2d');
    expect(report.dataset.priorAiCritiques.artifacts[1]?.modelId).toBe('GPT-6-family');
    expect(report.dataset.priorAiCritiques.artifacts[1]?.reportSha256)
      .toBe('d0cb6677cd0c08cbb520f3bc2ed8fe53137943a0b036fda4fbe96893dabef1e7');
    expect(report.dataset.priorAiCritiques.artifacts.every((item) => item.datasetSha256 === contract.datasetSha256)).toBe(true);
    expect(report.reportSha256).toMatch(/^[0-9a-f]{64}$/);
    const { reportSha256, ...withoutHash } = report;
    expect(reportSha256).toBe(createHash('sha256').update(JSON.stringify(withoutHash)).digest('hex'));
    expect(JSON.stringify(report)).not.toContain('reviewerId');
    expect(JSON.stringify(report)).not.toContain('manifestClaimsApproval');
    expect(JSON.stringify(report)).not.toContain('promptTemplateSha256');
  });

  it('sanitizes per-case records and fills an incomplete run as not attempted', () => {
    const report = createReport(1);
    expect(report.exploratoryComparison.attempts).toHaveLength(6);
    expect(report.exploratoryComparison.attempts[0]?.requestStatus).toBe('not_attempted');
    expect(report.exploratoryComparison.attempts[1]?.requestStatus).toBe('not_attempted');
    const serialized = JSON.stringify(report);
    for (const scenario of groundedBalancedScenarios) {
      expect(serialized).not.toContain(scenario.caseFacts);
      expect(serialized).not.toContain(scenario.reviewRationale);
      for (const evidence of scenario.sources) expect(serialized).not.toContain(evidence.content);
    }
  });

  it('does not label a partial set of attempts completed', () => {
    expect(() => createAiAssistedExploratoryEvaluationV1Report({ status: 'completed_exploratory', startedAt: isoStart,
      finishedAt: isoStart, ollamaVersion: contract.ollamaVersion, source, machineContract: fixedRuntime,
      attempts: attempts(1), observations: observations(1) })).toThrow('exploratory_report_completion_invalid');
  });

  it('rejects changed settings, duplicate scenarios, and report data outside the frozen six-case set', () => {
    expect(() => createAiAssistedExploratoryEvaluationV1Report({ ...{
      status: 'in_progress' as const, startedAt: isoStart, finishedAt: isoStart, ollamaVersion: contract.ollamaVersion,
      source, machineContract: { ...fixedRuntime, retries: 1 }, attempts: [], observations: [],
    } })).toThrow('exploratory_report_contract_invalid');

    const first = groundedBalancedScenarios[0]!;
    const duplicate = createBalancedObservation(first, 'not_attempted');
    expect(() => createAiAssistedExploratoryEvaluationV1Report({ status: 'in_progress', startedAt: isoStart,
      finishedAt: isoStart, ollamaVersion: contract.ollamaVersion, source, machineContract: fixedRuntime,
      attempts: [attempts(1)[0]!, attempts(1)[0]!], observations: [duplicate, duplicate] }))
      .toThrow('exploratory_report_scenarios_invalid');
  });

  it('validates release, tree, runner pins, exact base identity, and all protected source hashes', () => {
    const build = (sourceOverride: Partial<typeof source>) => createAiAssistedExploratoryEvaluationV1Report({
      status: 'in_progress', startedAt: isoStart, finishedAt: isoStart, ollamaVersion: contract.ollamaVersion,
      source: { ...source, ...sourceOverride }, machineContract: fixedRuntime, attempts: [], observations: [],
    });
    expect(() => build({ codeCommit: 'bad' })).toThrow('exploratory_report_contract_invalid');
    expect(() => build({ treeHash: 'not-a-tree' })).toThrow('exploratory_report_contract_invalid');
    expect(() => build({ repositoryBaseCommit: 'b'.repeat(40) })).toThrow('exploratory_report_contract_invalid');
    expect(() => build({ exploratoryRunnerSha256: 'c'.repeat(64) })).toThrow('exploratory_report_contract_invalid');
    expect(() => build({ exploratoryRunnerReleaseCommit: 'd'.repeat(40) })).toThrow('exploratory_report_contract_invalid');
    expect(() => build({ protectedFileSha256: { ...source.protectedFileSha256,
      'apps/api/src/ai/grounded-provider.ts': 'e'.repeat(64) } })).toThrow('exploratory_report_contract_invalid');
    const missingProviderHash: Record<string, string> = { ...source.protectedFileSha256 };
    delete missingProviderHash['apps/api/src/ai/grounded-provider.ts'];
    expect(() => build({ protectedFileSha256: missingProviderHash })).toThrow('exploratory_report_contract_invalid');
  });

  it('drives the shared balanced runner with a mock provider and builds a non-qualifying report', async () => {
    let providerCalls = 0;
    let active = 0;
    let maximumActive = 0;
    const run = await runGroundedBalancedEvaluation({
      healthCheck: async () => true,
      sourcesFor: mockSourcesFor,
      providerFactory: (emit) => ({ model: 'deterministic-mock', async analyze(input, _signal, correlationId) {
        providerCalls++;
        active++;
        maximumActive = Math.max(maximumActive, active);
        const scenario = groundedBalancedScenarios.find((item) => item.caseFacts === input.caseFacts)!;
        emit({ event: 'ai_grounded_analysis', outcome: 'success', correlationId, latencyMs: 1 });
        const output = mockOutput(scenario, input.sources);
        active--;
        return { output, metrics: { latencyMs: 1, promptTokens: 8, generatedTokens: 9 } };
      } }),
    });
    const report = createAiAssistedExploratoryEvaluationV1Report({ status: 'completed_exploratory',
      startedAt: isoStart, finishedAt: isoStart, ollamaVersion: contract.ollamaVersion, source, machineContract: fixedRuntime,
      attempts: run.attempts, observations: run.observations });
    expect(providerCalls).toBe(6);
    expect(maximumActive).toBe(1);
    expect(run.attempts.every((item) => item.status === 'success')).toBe(true);
    expect(report.machineContract.status).toBe('complete');
    expect(report.machineContract.providerInvocationCount).toBe(6);
    expect(report.qualificationStatus).toBe('NOT_QUALIFIED');
    expect(report.dataset.humanApprovalStatus).toBe('NOT_VERIFIED');
    expect(report.exploratoryComparison.semanticEvidenceValidation).toBe('NOT_ASSESSED');
  });

  it('uses the production orchestration gate order and invokes no provider before confirmation', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'aegis-exploratory-orchestration-'));
    const trace: string[] = [];
    const providerFactory = vi.fn();
    const reserveReport = vi.fn();
    try {
      const ports = makeOrchestrationPorts(join(tempRoot, 'evaluations', 'report.json'), trace, {
        confirm: async () => { trace.push('confirm'); return false; },
        providerFactory: providerFactory as unknown as ExploratoryOrchestrationPorts['providerFactory'],
        reserveReport: reserveReport as unknown as ExploratoryOrchestrationPorts['reserveReport'],
      });
      const result = await runAiAssistedExploratoryOrchestration(ports);
      expect(result).toMatchObject({ status: 'cancelled', providerInvocationCount: 0, reportPath: null, reportSha256: null });
      expect(trace.filter((item) => ['source', 'dataset', 'runtime', 'report_path', 'model', 'confirm'].includes(item)))
        .toEqual(['source', 'dataset', 'runtime', 'report_path', 'model', 'confirm']);
      expect(providerFactory).not.toHaveBeenCalled();
      expect(reserveReport).not.toHaveBeenCalled();
      await expect(stat(ports.reportPath)).rejects.toThrow();
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it.each(['source', 'dataset'] as const)('%s preflight failure prevents every later gate and provider call', async (failureGate) => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'aegis-exploratory-gate-failure-'));
    const path = join(tempRoot, 'evaluations', 'report.json');
    const trace: string[] = [];
    const runtime = vi.fn(async () => {
      trace.push('runtime');
      return { ollamaVersion: contract.ollamaVersion,
        providerConfig: { model: contract.model, timeoutMs: contract.timeoutMs, maxConcurrent: 1 } };
    });
    const checkReport = vi.fn(async () => { trace.push('report_path'); });
    const model = vi.fn(async () => { trace.push('model'); });
    const confirmGate = vi.fn(async () => { trace.push('confirm'); return true; });
    const reserve = vi.fn(async () => { trace.push('reserve'); throw new Error('must_not_reserve'); });
    const providerFactory = vi.fn();
    try {
      const ports = makeOrchestrationPorts(path, trace, {
        preflightSource: async () => {
          trace.push('source');
          if (failureGate === 'source') throw new Error('source_gate_failed');
          return source;
        },
        preflightDataset: async () => {
          trace.push('dataset');
          if (failureGate === 'dataset') throw new Error('dataset_digest_mismatch');
        },
        preflightRuntime: runtime,
        checkReportAvailable: checkReport,
        preflightModel: model,
        confirm: confirmGate,
        reserveReport: reserve,
        providerFactory: providerFactory as unknown as ExploratoryOrchestrationPorts['providerFactory'],
      });
      await expect(runAiAssistedExploratoryOrchestration(ports)).rejects.toThrow(
        failureGate === 'source' ? 'source_gate_failed' : 'dataset_digest_mismatch');
      expect(runtime).not.toHaveBeenCalled();
      expect(checkReport).not.toHaveBeenCalled();
      expect(model).not.toHaveBeenCalled();
      expect(confirmGate).not.toHaveBeenCalled();
      expect(reserve).not.toHaveBeenCalled();
      expect(providerFactory).not.toHaveBeenCalled();
      await expect(stat(path)).rejects.toThrow();
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it.each(['runtime', 'model'] as const)('%s prerequisite failure is fail-closed and sanitized', async (failureGate) => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'aegis-exploratory-preflight-failure-'));
    const path = join(tempRoot, 'evaluations', 'report.json');
    const trace: string[] = [];
    const providerFactory = vi.fn();
    const reserveReport = vi.fn();
    const checkReportAvailable = vi.fn(async () => { trace.push('report_path'); });
    const preflightModel = vi.fn(async () => {
      trace.push('model');
      if (failureGate === 'model') {
        validateExploratoryModelIdentity({ models: [{ name: contract.model, digest: `sha256:${'0'.repeat(64)}` }] }, { models: [] });
      }
    });
    const output = vi.fn();
    const ports = makeOrchestrationPorts(path, trace, {
      preflightRuntime: async () => {
        trace.push('runtime');
        if (failureGate === 'runtime') {
          validateExploratoryRuntime('0.0.0', { model: contract.model, timeoutMs: contract.timeoutMs,
            maxConcurrent: contract.maximumConcurrency }, contract.endpoint);
        }
        return { ollamaVersion: contract.ollamaVersion,
          providerConfig: { model: contract.model, timeoutMs: contract.timeoutMs, maxConcurrent: contract.maximumConcurrency } };
      },
      checkReportAvailable,
      preflightModel,
      output,
      providerFactory: providerFactory as unknown as ExploratoryOrchestrationPorts['providerFactory'],
      reserveReport: reserveReport as unknown as ExploratoryOrchestrationPorts['reserveReport'],
    });
    try {
      let caught: unknown;
      try { await runAiAssistedExploratoryOrchestration(ports); } catch (error) { caught = error; }
      expect(caught).toBeInstanceOf(Error);
      expect((caught as Error).message).toBe(failureGate === 'runtime'
        ? 'exploratory_runtime_contract_mismatch' : 'exploratory_model_unavailable');
      const sanitized = safeAiAssistedExploratoryFailure(failureGate === 'runtime' ? 'runtime_preflight' : 'model_preflight');
      expect(sanitized).not.toContain('private-detail');
      expect(JSON.parse(sanitized)).toMatchObject({ event: 'ai_assisted_exploratory_evaluation_v1_failed',
        failureStage: failureGate === 'runtime' ? 'runtime_preflight' : 'model_preflight' });
      expect(checkReportAvailable).toHaveBeenCalledTimes(failureGate === 'runtime' ? 0 : 1);
      expect(preflightModel).toHaveBeenCalledTimes(failureGate === 'runtime' ? 0 : 1);
      expect(reserveReport).not.toHaveBeenCalled();
      expect(providerFactory).not.toHaveBeenCalled();
      expect(trace).not.toContain('confirm');
      expect(output).not.toHaveBeenCalled();
      await expect(stat(path)).rejects.toThrow();
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it.each(['occupied', 'dangling_symlink'] as const)('report path %s stops before model, confirmation, and provider', async (kind) => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'aegis-exploratory-path-gate-'));
    const path = join(tempRoot, 'evaluations', 'report.json');
    const trace: string[] = [];
    const providerFactory = vi.fn();
    const model = vi.fn(async () => { trace.push('model'); });
    const confirm = vi.fn(async () => { trace.push('confirm'); return true; });
    const reserve = vi.fn();
    try {
      await mkdir(join(tempRoot, 'evaluations'), { mode: 0o700 });
      if (kind === 'occupied') await writeFile(path, 'preserve-this', { flag: 'wx', mode: 0o600 });
      else await symlink(join(tempRoot, 'missing-target'), path);
      const ports = makeOrchestrationPorts(path, trace, {
        checkReportAvailable: (report) => assertExploratoryReportPathAbsent(report),
        preflightModel: model,
        confirm,
        reserveReport: reserve as unknown as ExploratoryOrchestrationPorts['reserveReport'],
        providerFactory: providerFactory as unknown as ExploratoryOrchestrationPorts['providerFactory'],
      });
      await expect(runAiAssistedExploratoryOrchestration(ports)).rejects.toThrow(
        kind === 'occupied' ? 'exploratory_report_path_occupied' : 'exploratory_report_path_occupied');
      expect(model).not.toHaveBeenCalled();
      expect(confirm).not.toHaveBeenCalled();
      expect(reserve).not.toHaveBeenCalled();
      expect(providerFactory).not.toHaveBeenCalled();
      expect(trace.some((item) => item.startsWith('output:'))).toBe(false);
      if (kind === 'occupied') expect(await readFileBytes(path, 'utf8')).toBe('preserve-this');
      else expect((await lstat(path)).isSymbolicLink()).toBe(true);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('fails closed on report reservation failure without invoking the provider', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'aegis-exploratory-reservation-failure-'));
    const unsafeParent = join(tempRoot, 'unsafe');
    await mkdir(unsafeParent, { mode: 0o700 });
    await chmod(unsafeParent, 0o755);
    const path = join(unsafeParent, 'evaluations', 'report.json');
    const providerFactory = vi.fn();
    const confirm = vi.fn(async () => true);
    const output = vi.fn();
    try {
      const ports = makeOrchestrationPorts(path, [], {
        checkReportAvailable: async () => undefined,
        reserveReport: async (report) => {
          const handle = await reservePrivateReport(report);
          return { write: (value) => writePrivateReport(handle, value), close: () => handle.close() };
        },
        providerFactory: providerFactory as unknown as ExploratoryOrchestrationPorts['providerFactory'],
        confirm,
        output,
      });
      await expect(runAiAssistedExploratoryOrchestration(ports)).rejects.toThrow('Evaluation report parent permissions are unsafe.');
      expect(confirm).toHaveBeenCalledOnce();
      expect(providerFactory).not.toHaveBeenCalled();
      expect(output).not.toHaveBeenCalled();
      await expect(stat(path)).rejects.toThrow();
    } finally {
      await chmod(unsafeParent, 0o700);
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('preserves the exclusively reserved incomplete report when the first report write fails', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'aegis-exploratory-write-failure-'));
    const path = join(tempRoot, 'evaluations', 'report.json');
    const providerFactory = vi.fn();
    const close = vi.fn(async () => undefined);
    const write = vi.fn(async () => { throw new Error('raw-writer-detail'); });
    const output = vi.fn();
    try {
      const ports = makeOrchestrationPorts(path, [], {
        reserveReport: async () => {
          await mkdir(join(tempRoot, 'evaluations'), { mode: 0o700 });
          await writeFile(path, '', { flag: 'wx', mode: 0o600 });
          return { write, close };
        },
        providerFactory: providerFactory as unknown as ExploratoryOrchestrationPorts['providerFactory'],
        output,
      });
      await expect(runAiAssistedExploratoryOrchestration(ports)).rejects.toThrow('exploratory_run_failed');
      expect(write).toHaveBeenCalledOnce();
      expect(close).toHaveBeenCalledOnce();
      expect(providerFactory).not.toHaveBeenCalled();
      expect(output).not.toHaveBeenCalled();
      expect(ports.output).not.toHaveBeenCalled();
      expect(await readFileBytes(path, 'utf8')).toBe('');
      expect((await stat(path)).mode & 0o777).toBe(0o600);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('preserves the last durable progress report and stops after a progress write failure', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'aegis-exploratory-progress-write-failure-'));
    const path = join(tempRoot, 'evaluations', 'report.json');
    const providerFactory = vi.fn((_prepared: PreparedExploratoryRun, emit: (event: SafeProviderEvent) => void) => ({
      model: 'mock-only', async analyze(input: Parameters<GroundedAnalysisProvider['analyze']>[0], _signal: AbortSignal, correlationId: string) {
        const scenario = groundedBalancedScenarios.find((item) => item.caseFacts === input.caseFacts)!;
        emit({ event: 'ai_grounded_analysis', outcome: 'success', correlationId, latencyMs: 1 });
        return { output: mockOutput(scenario, input.sources), metrics: { latencyMs: 1, promptTokens: 8, generatedTokens: 9 } };
      },
    }));
    let writeCount = 0;
    const close = vi.fn(async () => undefined);
    const output = vi.fn();
    try {
      const ports = makeOrchestrationPorts(path, [], {
        reserveReport: async (report) => {
          const handle = await reservePrivateReport(report);
          return { write: async (value) => {
            writeCount++;
            if (writeCount === 2) throw new Error('raw-progress-write-detail');
            await writePrivateReport(handle, value);
          }, close: async () => { await handle.close(); await close(); } };
        },
        providerFactory: providerFactory as unknown as ExploratoryOrchestrationPorts['providerFactory'],
        output,
      });
      await expect(runAiAssistedExploratoryOrchestration(ports)).rejects.toThrow('exploratory_run_failed');
      expect(writeCount).toBe(2);
      expect(providerFactory).toHaveBeenCalledOnce();
      expect(close).toHaveBeenCalledOnce();
      expect(output).not.toHaveBeenCalled();
      const saved = await readFileBytes(path, 'utf8');
      expect(JSON.parse(saved)).toMatchObject({ status: 'in_progress', qualificationStatus: 'NOT_QUALIFIED' });
      expect(saved).not.toContain('raw-progress-write-detail');
      expect((await stat(path)).mode & 0o777).toBe(0o600);
      await expect(reservePrivateReport(path)).rejects.toThrow();
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('preserves the completed private report and does not retry a failed close', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'aegis-exploratory-close-failure-'));
    const path = join(tempRoot, 'evaluations', 'report.json');
    const providerFactory = vi.fn((_prepared: PreparedExploratoryRun, emit: (event: SafeProviderEvent) => void) => ({
      model: 'mock-only', async analyze(input: Parameters<GroundedAnalysisProvider['analyze']>[0], _signal: AbortSignal, correlationId: string) {
        const scenario = groundedBalancedScenarios.find((item) => item.caseFacts === input.caseFacts)!;
        emit({ event: 'ai_grounded_analysis', outcome: 'success', correlationId, latencyMs: 1 });
        return { output: mockOutput(scenario, input.sources), metrics: { latencyMs: 1, promptTokens: 8, generatedTokens: 9 } };
      },
    }));
    const close = vi.fn(async () => { throw new Error('raw-close-detail'); });
    const output = vi.fn();
    try {
      const ports = makeOrchestrationPorts(path, [], {
        reserveReport: async (report) => {
          const handle = await reservePrivateReport(report);
          return { write: (value) => writePrivateReport(handle, value), close: async () => { await handle.close(); await close(); } };
        },
        providerFactory: providerFactory as unknown as ExploratoryOrchestrationPorts['providerFactory'],
        output,
      });
      await expect(runAiAssistedExploratoryOrchestration(ports)).rejects.toThrow('exploratory_run_failed');
      expect(providerFactory).toHaveBeenCalledTimes(6);
      expect(close).toHaveBeenCalledOnce();
      expect(output).not.toHaveBeenCalled();
      const saved = await readFileBytes(path, 'utf8');
      expect(JSON.parse(saved)).toMatchObject({ status: 'completed_exploratory', qualificationStatus: 'NOT_QUALIFIED' });
      expect(saved).not.toContain('raw-close-detail');
      expect((await stat(path)).mode & 0o777).toBe(0o600);
      await expect(reservePrivateReport(path)).rejects.toThrow();
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('runs six sequential mocked provider calls only after every gate and confirmation', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'aegis-exploratory-success-'));
    const path = join(tempRoot, 'evaluations', 'report.json');
    const trace: string[] = [];
    const providerInputs: unknown[] = [];
    let active = 0;
    let maxActive = 0;
    const providerFactory = vi.fn((_prepared: PreparedExploratoryRun, emit: (event: SafeProviderEvent) => void) => ({
      model: 'mock-only', async analyze(input: Parameters<GroundedAnalysisProvider['analyze']>[0], _signal: AbortSignal, correlationId: string) {
      trace.push('provider_factory');
      providerInputs.push(input);
      active++;
      maxActive = Math.max(maxActive, active);
      const scenario = groundedBalancedScenarios.find((item) => item.caseFacts === input.caseFacts)!;
      emit({ event: 'ai_grounded_analysis', outcome: 'success', correlationId, latencyMs: 1 });
      active--;
      return { output: mockOutput(scenario, input.sources), metrics: { latencyMs: 1, promptTokens: 8, generatedTokens: 9 } };
    } }));
    try {
      const ports = makeOrchestrationPorts(path, trace, {
        providerFactory: providerFactory as unknown as ExploratoryOrchestrationPorts['providerFactory'],
      });
      const result = await runAiAssistedExploratoryOrchestration(ports);
      const report = JSON.parse(await readFileBytes(path, 'utf8')) as {
        status: string; qualificationStatus: string; machineContract: { providerInvocationCount: number };
        dataset: { humanApprovalStatus: string }; exploratoryComparison: { semanticEvidenceValidation: string };
      };
      expect(result).toMatchObject({ status: 'completed_exploratory', providerInvocationCount: 6 });
      expect(providerFactory).toHaveBeenCalledTimes(6);
      expect(providerInputs).toHaveLength(6);
      expect(maxActive).toBe(1);
      expect(trace.indexOf('confirm')).toBeLessThan(trace.indexOf('provider_factory'));
      expect(providerFactory.mock.calls.every(([prepared]) => prepared.providerConfig.timeoutMs === contract.timeoutMs)).toBe(true);
      expect(providerFactory.mock.calls.every(([prepared]) => prepared.providerConfig.maxConcurrent === 1)).toBe(true);
      expect(providerInputs.every((input) => Object.keys(input as object).sort().join(',') === 'caseFacts,caseStatus,caseType,sources')).toBe(true);
      expect(report).toMatchObject({ status: 'completed_exploratory', qualificationStatus: 'NOT_QUALIFIED',
        machineContract: { providerInvocationCount: 6 }, dataset: { humanApprovalStatus: 'NOT_VERIFIED' },
        exploratoryComparison: { semanticEvidenceValidation: 'NOT_ASSESSED' } });
      expect((await stat(path)).mode & 0o777).toBe(0o600);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('passes the frozen 15-second timeout through the provider abort signal using mocked fetch only', async () => {
    vi.useFakeTimers();
    try {
      const providerConfig = { model: contract.model, timeoutMs: contract.timeoutMs, maxConcurrent: contract.maximumConcurrency };
      const sourceBundle = mockSourcesFor(groundedBalancedScenarios[0]!);
      const events: SafeProviderEvent[] = [];
      const fetchImpl = vi.fn((_input: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('mocked-timeout-detail')), { once: true });
      }));
      const provider = createGroundedOllamaProvider(providerConfig, { fetchImpl: fetchImpl as typeof fetch,
        log: (event) => events.push(event) });
      const pending = provider.analyze({ caseStatus: 'in_progress', caseType: groundedBalancedScenarios[0]!.caseType,
        caseFacts: groundedBalancedScenarios[0]!.caseFacts, sources: sourceBundle.sources }, new AbortController().signal, randomUUID());
      const rejection = expect(pending).rejects.toMatchObject({ state: 'PROVIDER_UNAVAILABLE' });
      await vi.advanceTimersByTimeAsync(contract.timeoutMs);
      await rejection;
      expect(fetchImpl).toHaveBeenCalledOnce();
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ outcome: 'failure', failureStage: 'generation_timeout', latencyMs: contract.timeoutMs });
      expect(JSON.stringify(events)).not.toContain('mocked-timeout-detail');
    } finally {
      vi.useRealTimers();
    }
  });

  it('enforces provider timeout through the actual orchestration with no live network', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'aegis-exploratory-orchestration-timeout-'));
    const path = join(tempRoot, 'evaluations', 'report.json');
    vi.useFakeTimers();
    const events: SafeProviderEvent[] = [];
    const fetchImpl = vi.fn((_input: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('mocked-timeout-detail')), { once: true });
    }));
    const providerFactory = vi.fn((prepared: PreparedExploratoryRun, emit: (event: SafeProviderEvent) => void) =>
      createGroundedOllamaProvider(prepared.providerConfig, { fetchImpl: fetchImpl as typeof fetch,
        log: (event) => { events.push(event); emit(event); } }));
    try {
      const pending = runAiAssistedExploratoryOrchestration(makeOrchestrationPorts(path, [], {
        providerFactory: providerFactory as unknown as ExploratoryOrchestrationPorts['providerFactory'],
      }));
      await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledOnce(), { timeout: 1000 });
      expect(fetchImpl.mock.calls[0]?.[0]).toBe(contract.endpoint);
      await vi.advanceTimersByTimeAsync(contract.timeoutMs);
      const result = await pending;
      const contents = await readFileBytes(path, 'utf8');
      const report = JSON.parse(contents) as { status: string; machineContract: { providerInvocationCount: number };
        exploratoryComparison: { attempts: Array<{ failureStage: string | null }> } };
      expect(result).toMatchObject({ status: 'incomplete', providerInvocationCount: 1 });
      expect(fetchImpl).toHaveBeenCalledOnce();
      expect(report).toMatchObject({ status: 'incomplete', machineContract: { providerInvocationCount: 1 } });
      expect(report.exploratoryComparison.attempts[0]?.failureStage).toBe('generation_timeout');
      expect(events).toHaveLength(1);
      expect(JSON.stringify(report)).not.toContain('mocked-timeout-detail');
    } finally {
      vi.useRealTimers();
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('preserves sanitized progress after a mocked provider transport failure without retrying', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'aegis-exploratory-failure-'));
    const path = join(tempRoot, 'evaluations', 'report.json');
    const trace: string[] = [];
    const providerCalls = vi.fn(async (_input: unknown, _signal: AbortSignal, correlationId: string) => {
      trace.push('provider_call');
      throw new Error(`secret-must-not-be-retained:${correlationId}`);
    });
    const providerFactory = vi.fn((_prepared: PreparedExploratoryRun, emit: (event: SafeProviderEvent) => void) => ({
      model: 'mock-only', analyze: async (input: Parameters<GroundedAnalysisProvider['analyze']>[0], signal: AbortSignal, correlationId: string) => {
      emit({ event: 'ai_grounded_analysis', outcome: 'failure', correlationId, failureStage: 'provider_connection', latencyMs: 1 });
      return providerCalls(input, signal, correlationId) as never;
    } }));
    try {
      const result = await runAiAssistedExploratoryOrchestration(makeOrchestrationPorts(path, trace, {
        providerFactory: providerFactory as unknown as ExploratoryOrchestrationPorts['providerFactory'],
      }));
      const contents = await readFileBytes(path, 'utf8');
      const report = JSON.parse(contents) as { status: string; machineContract: { providerInvocationCount: number };
        exploratoryComparison: { attempts: Array<{ requestStatus: string; failureStage: string | null }> } };
      expect(result).toMatchObject({ status: 'incomplete', providerInvocationCount: 1 });
      expect(providerCalls).toHaveBeenCalledOnce();
      expect(providerFactory).toHaveBeenCalledOnce();
      expect(report).toMatchObject({ status: 'incomplete', machineContract: { providerInvocationCount: 1 } });
      expect(report.exploratoryComparison.attempts[0]).toMatchObject({ requestStatus: 'failure', failureStage: 'provider_connection' });
      expect(report.exploratoryComparison.attempts.slice(1).every((item) => item.requestStatus === 'not_attempted')).toBe(true);
      expect(contents).not.toContain('secret-must-not-be-retained');
      expect((await stat(path)).mode & 0o777).toBe(0o600);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('records malformed mocked model responses through the real parser without network access or retry', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'aegis-exploratory-malformed-'));
    const path = join(tempRoot, 'evaluations', 'report.json');
    const fetchImpl = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as { prompt: string };
      const context = JSON.parse(request.prompt.split('UNTRUSTED_CASE_FACTS_AND_RETRIEVED_SOURCES=')[1] ?? '{}') as {
        caseFacts: string; sources: GroundedSource[];
      };
      const scenario = groundedBalancedScenarios.find((item) => item.caseFacts === context.caseFacts)!;
      const invalid = { ...mockOutput(scenario, context.sources), humanReviewRequired: false };
      return new Response(JSON.stringify({ model: contract.model, done: true, response: JSON.stringify(invalid),
        done_reason: 'stop', prompt_eval_count: 8, eval_count: 9 }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    const providerFactory = vi.fn((prepared: PreparedExploratoryRun, emit: (event: SafeProviderEvent) => void) =>
      createGroundedOllamaProvider(prepared.providerConfig, { fetchImpl: fetchImpl as typeof fetch, log: emit }));
    try {
      const result = await runAiAssistedExploratoryOrchestration(makeOrchestrationPorts(path, [], {
        providerFactory: providerFactory as unknown as ExploratoryOrchestrationPorts['providerFactory'],
      }));
      const contents = await readFileBytes(path, 'utf8');
      const report = JSON.parse(contents) as { status: string; qualificationStatus: string;
        machineContract: { status: string; providerInvocationCount: number };
        exploratoryComparison: { attempts: Array<{ requestStatus: string; validationReason: string | null }> } };
      expect(result).toMatchObject({ status: 'completed_exploratory', providerInvocationCount: 6 });
      expect(providerFactory).toHaveBeenCalledTimes(6);
      expect(report).toMatchObject({ status: 'completed_exploratory', qualificationStatus: 'NOT_QUALIFIED',
        machineContract: { status: 'incomplete_or_failed', providerInvocationCount: 6 } });
      expect(report.exploratoryComparison.attempts.every((item) => item.requestStatus === 'failure' &&
        item.validationReason === 'invalid_human_review')).toBe(true);
      expect(fetchImpl).toHaveBeenCalledTimes(6);
      expect(fetchImpl.mock.calls.every(([url]) => String(url) === contract.endpoint)).toBe(true);
      expect(contents).not.toContain('Deterministic mock fixture output.');
      expect(contents).not.toContain('raw model rationale');
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('rejects existing files, dangling symlinks, symlink directories, and unsafe report parents', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'aegis-exploratory-paths-'));
    try {
      const occupied = join(tempRoot, 'occupied.json');
      await writeFile(occupied, '{}', { mode: 0o600, flag: 'wx' });
      await expect(assertExploratoryReportPathAbsent(occupied)).rejects.toThrow('exploratory_report_path_occupied');

      const danglingLink = join(tempRoot, 'dangling-report.json');
      await symlink(join(tempRoot, 'does-not-exist'), danglingLink);
      await expect(assertExploratoryReportPathAbsent(danglingLink)).rejects.toThrow('exploratory_report_path_occupied');

      const symlinkTarget = join(tempRoot, 'target');
      await mkdir(symlinkTarget, { mode: 0o700 });
      await symlink(symlinkTarget, join(tempRoot, 'evaluations'));
      await expect(reservePrivateReport(join(tempRoot, 'evaluations', 'report.json'))).rejects.toThrow();

      const unsafeParent = join(tempRoot, 'unsafe-parent');
      await mkdir(unsafeParent, { mode: 0o700 });
      await chmod(unsafeParent, 0o755);
      await expect(reservePrivateReport(join(unsafeParent, 'evaluations', 'report.json'))).rejects.toThrow();
      await chmod(unsafeParent, 0o700);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('does not import the human-approval manifest parser, evaluator, or report builder', async () => {
    const runner = await readFile(new URL('./run-ai-assisted-exploratory-evaluation-v1-local.ts', import.meta.url), 'utf8');
    const reportBuilder = await readFile(new URL('./ai-assisted-exploratory-evaluation-v1.ts', import.meta.url), 'utf8');
    for (const forbidden of ['parseGroundedAiQualificationV1DatasetReview', 'evaluateGroundedAiQualificationV1',
      'createGroundedAiQualificationV1Report', 'AEGIS_DATASET_REVIEW']) {
      expect(runner).not.toContain(forbidden);
      expect(reportBuilder).not.toContain(forbidden);
    }
  });

  it('uses exclusive private report creation and rejects a collision', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'aegis-exploratory-report-'));
    const path = join(tempRoot, 'evaluations', 'report.json');
    try {
      const handle = await reservePrivateReport(path);
      await handle.close();
      expect((await stat(path)).mode & 0o777).toBe(0o600);
      expect((await stat(join(tempRoot, 'evaluations'))).mode & 0o777).toBe(0o700);
      await expect(reservePrivateReport(path)).rejects.toThrow();
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });
});

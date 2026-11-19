import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { lstat, readFile } from 'node:fs/promises';
import { get } from 'node:http';
import { stdin, stdout } from 'node:process';
import { createInterface } from 'node:readline/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGroundedOllamaProvider } from '../grounded-provider.js';
import { localOllamaGenerateEndpoint, resolveOllamaConfig } from '../provider.js';
import type { OllamaConfig } from '../provider.js';
import type { GroundedAnalysisProvider, GroundedSource } from '../grounded-analysis.js';
import { assertSafeOllamaTcpRecords, parseOllamaTcpRecords } from './ollama-socket-preflight.js';
import { groundedBalancedScenarios, validateGroundedBalancedDataset, type GroundedBalancedScenario } from './grounded-balanced-dataset.js';
import { runGroundedBalancedEvaluation } from './grounded-balanced-runner.js';
import type { SafeProviderEvent } from './grounded-provider-diagnostics.js';
import { replacePrivateReportAtomically, reservePrivateReport } from './private-report.js';
import { groundedAiQualificationV1DatasetSha256, verifyGroundedAiQualificationV1Source } from './grounded-ai-qualification-v1.js';
import { assertNoDiagnosticProxy } from './run-grounded-supported-output-diagnostic-local.js';
import {
  aiAssistedExploratoryEvaluationV1Contract as contract,
  aiAssistedExploratoryEvaluationV1ReportRelativePath,
  createAiAssistedExploratoryEvaluationV1Report,
  verifyAiAssistedExploratoryRunnerIdentity,
  type AiAssistedExploratorySourceIdentity,
} from './ai-assisted-exploratory-evaluation-v1.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../../');
const reportPath = resolve(root, aiAssistedExploratoryEvaluationV1ReportRelativePath);
const contractHelperRelativePath = 'apps/api/src/ai/evaluation/ai-assisted-exploratory-evaluation-v1.ts';
const reviewedContractHelperSha256 = 'f7ead42029fe58bacf2729495cfed8960dca84f0261242a9f268a7f5498bf4d2';
const confirmation = 'RUN AI-ASSISTED EXPLORATORY EVALUATION V1';
const stages = ['source_preflight', 'dataset_preflight', 'runtime_preflight', 'model_preflight',
  'operator_confirmation', 'report_reservation', 'provider_evaluation', 'report_write', 'report_close', 'unknown'] as const;
type Stage = typeof stages[number];
let stage: Stage = 'source_preflight';

export function safeAiAssistedExploratoryFailure(value: string): string {
  const failureStage = stages.includes(value as Stage) ? value : 'unknown';
  return JSON.stringify({ event: 'ai_assisted_exploratory_evaluation_v1_failed', failureStage });
}

function git(args: readonly string[]): string {
  return execFileSync('git', [...args], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
}

function gitBlobSha256(ref: string, filePath: string): string {
  return createHash('sha256').update(execFileSync('git', ['show', `${ref}:${filePath}`], {
    cwd: root, stdio: ['ignore', 'pipe', 'ignore'],
  })).digest('hex');
}

function gitBlobBytes(ref: string, filePath: string): Buffer {
  return execFileSync('git', ['show', `${ref}:${filePath}`], {
    cwd: root, stdio: ['ignore', 'pipe', 'ignore'],
  });
}

export function normalizedExploratoryContractHelperSha256(bytes: Uint8Array): string {
  const source = Buffer.from(bytes).toString('utf8');
  const pin = /(\breviewedRunnerSha256:\s*')([0-9a-f]{64})('\s*,)/g;
  const matches = source.match(pin);
  if (!matches || matches.length !== 1) throw new Error('exploratory_contract_helper_pin_shape_invalid');
  const normalized = source.replace(pin, (_match, prefix: string, _runnerSha: string, suffix: string) => `${prefix}<PIN>${suffix}`);
  return createHash('sha256').update(normalized, 'utf8').digest('hex');
}

export function verifyExploratoryContractHelperIdentity(localBytes: Uint8Array, releaseBytes: Uint8Array): string {
  const localHash = normalizedExploratoryContractHelperSha256(localBytes);
  const releaseHash = normalizedExploratoryContractHelperSha256(releaseBytes);
  if (localHash !== reviewedContractHelperSha256 || releaseHash !== reviewedContractHelperSha256) {
    throw new Error('exploratory_contract_helper_hash_mismatch');
  }
  return localHash;
}

export async function assertExploratoryReportPathAbsent(path: string): Promise<void> {
  try {
    await lstat(path);
    throw new Error('exploratory_report_path_occupied');
  } catch (error) {
    if (error instanceof Error && error.message === 'exploratory_report_path_occupied') throw error;
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw new Error('exploratory_report_path_unavailable');
  }
}

export function verifyExploratoryTransport(
  env: NodeJS.ProcessEnv,
  execArgv: readonly string[],
  endpoint: string,
): void {
  assertNoDiagnosticProxy(env, execArgv);
  if (endpoint !== contract.endpoint) throw new Error('exploratory_endpoint_not_approved');
}

function assertNoOtherOllamaClient(): void {
  const output = execFileSync('/usr/sbin/lsof', ['-nP', '-FpcnT', '-iTCP:11434'], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
  });
  assertSafeOllamaTcpRecords(parseOllamaTcpRecords(output), process.pid);
}

function localJson(path: '/api/tags' | '/api/ps'): Promise<unknown> {
  return new Promise((resolveValue, reject) => {
    const request = get(`http://127.0.0.1:11434${path}`, {
      agent: false,
      headers: { connection: 'close' },
    }, (response) => {
      const chunks: Buffer[] = [];
      let bytes = 0;
      response.on('data', (chunk: Buffer) => {
        bytes += chunk.byteLength;
        if (bytes > 32 * 1024) {
          request.destroy();
          reject(new Error('exploratory_health_response_too_large'));
          return;
        }
        chunks.push(chunk);
      });
      response.on('end', () => {
        if (response.statusCode !== 200) {
          reject(new Error('exploratory_health_status'));
          return;
        }
        try { resolveValue(JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown); }
        catch { reject(new Error('exploratory_health_json')); }
      });
    });
    request.setTimeout(3000, () => request.destroy(new Error('exploratory_health_timeout')));
    request.on('error', () => reject(new Error('exploratory_health_request')));
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function validateExploratoryModelIdentity(tags: unknown, ps: unknown): void {
  if (!isRecord(tags) || !Array.isArray(tags.models) || !tags.models.some((item) => isRecord(item) &&
      item.name === contract.model && item.digest === contract.modelManifestDigest) ||
      !isRecord(ps) || !Array.isArray(ps.models)) throw new Error('exploratory_model_unavailable');
  if (ps.models.some((item) => !isRecord(item) || (item.name !== contract.model && item.model !== contract.model))) {
    throw new Error('exploratory_competing_model_loaded');
  }
}

async function assertModelReady(): Promise<void> {
  assertNoOtherOllamaClient();
  const [tags, ps] = await Promise.all([localJson('/api/tags'), localJson('/api/ps')]);
  validateExploratoryModelIdentity(tags, ps);
  assertNoOtherOllamaClient();
}

function getOllamaVersion(): string {
  const output = execFileSync('ollama', ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  return output.match(/\b(\d+\.\d+\.\d+)\b/)?.[1] ?? '';
}

async function confirm(): Promise<boolean> {
  if (!stdin.isTTY || !stdout.isTTY) throw new Error('exploratory_interactive_terminal_required');
  const prompt = createInterface({ input: stdin, output: stdout });
  try {
    return await prompt.question(`This makes at most six local model requests. Type ${confirmation}: `) === confirmation;
  } finally { prompt.close(); }
}

function sourcesFor(scenario: typeof groundedBalancedScenarios[number]) {
  return {
    tenant: scenario.tenant,
    sources: scenario.sources.map((source) => ({ citationId: randomUUID(), title: source.title,
      sourceIdentity: source.sourceIdentity, version: source.version, position: 0, content: source.content })),
  };
}

function machineContract() {
  return {
    requestLimit: contract.maximumRequests,
    attemptsPerScenarioLimit: contract.maximumAttemptsPerScenario,
    concurrencyLimit: contract.maximumConcurrency,
    retries: contract.retryCount,
    timeoutMs: contract.timeoutMs,
    temperature: contract.temperature,
    numPredict: contract.numPredict,
    loopbackEndpoint: contract.endpoint,
    cloudFallback: 'prohibited' as const,
    externalActions: 'prohibited' as const,
    humanReviewRequiredForRecommendations: true,
  };
}

async function reportHash(path: string): Promise<string> {
  return createHash('sha256').update(await readFile(path)).digest('hex');
}

export function verifyExploratoryDataset(expectedSha256: string = contract.datasetSha256): void {
  validateGroundedBalancedDataset(groundedBalancedScenarios);
  if (groundedAiQualificationV1DatasetSha256() !== expectedSha256 ||
      groundedBalancedScenarios.length !== contract.scenarios ||
      new Set(groundedBalancedScenarios.flatMap((scenario) => scenario.sources.map((item) => item.sourceIdentity))).size !== contract.distinctSources) {
    throw new Error('exploratory_dataset_contract_mismatch');
  }
}

export function validateExploratoryRuntime(version: string, providerConfig: OllamaConfig | undefined,
  endpoint: string): asserts providerConfig is OllamaConfig {
  if (version !== contract.ollamaVersion || !providerConfig || providerConfig.model !== contract.model ||
      providerConfig.timeoutMs !== contract.timeoutMs || providerConfig.maxConcurrent !== contract.maximumConcurrency ||
      endpoint !== contract.endpoint || contract.numPredict !== 256 || contract.retryCount !== 0) {
    throw new Error('exploratory_runtime_contract_mismatch');
  }
}

export interface PreparedExploratoryRun {
  source: AiAssistedExploratorySourceIdentity;
  ollamaVersion: string;
  providerConfig: OllamaConfig;
}

interface ExploratoryReportWriter {
  write(report: unknown): Promise<void>;
  close(): Promise<void>;
}

type ExploratoryStage = typeof stages[number];

export interface ExploratoryOrchestrationPorts {
  reportPath: string;
  preflightSource(): Promise<AiAssistedExploratorySourceIdentity>;
  preflightDataset(): Promise<void>;
  preflightRuntime(): Promise<{ ollamaVersion: string; providerConfig: OllamaConfig }>;
  checkReportAvailable(path: string): Promise<void>;
  preflightModel(prepared: PreparedExploratoryRun): Promise<void>;
  confirm(): Promise<boolean>;
  reserveReport(path: string): Promise<ExploratoryReportWriter>;
  providerFactory(prepared: PreparedExploratoryRun, log: (event: SafeProviderEvent) => void): GroundedAnalysisProvider;
  healthCheck(prepared: PreparedExploratoryRun): Promise<boolean>;
  sourcesFor(scenario: GroundedBalancedScenario): { tenant: GroundedBalancedScenario['tenant']; sources: GroundedSource[] };
  reportHash(path: string): Promise<string>;
  now(): Date;
  output(value: Record<string, unknown>): void;
  onStage?(stage: ExploratoryStage): void;
}

/** Shared orchestration used by the CLI and deterministic tests; production ports remain hardwired in main(). */
export async function runAiAssistedExploratoryOrchestration(ports: ExploratoryOrchestrationPorts): Promise<{
  status: 'cancelled' | 'completed_exploratory' | 'incomplete';
  providerInvocationCount: number;
  reportPath: string | null;
  reportSha256: string | null;
}> {
  const setStage = (next: ExploratoryStage): void => ports.onStage?.(next);
  setStage('source_preflight');
  const source = await ports.preflightSource();
  setStage('dataset_preflight');
  await ports.preflightDataset();
  setStage('runtime_preflight');
  const runtime = await ports.preflightRuntime();
  const prepared = { source, ...runtime };
  setStage('report_reservation');
  await ports.checkReportAvailable(ports.reportPath);
  setStage('model_preflight');
  await ports.preflightModel(prepared);
  setStage('operator_confirmation');
  if (!await ports.confirm()) {
    ports.output({ status: 'cancelled', providerInvocationCount: 0, reportPath: null, qualificationStatus: 'NOT_QUALIFIED' });
    return { status: 'cancelled', providerInvocationCount: 0, reportPath: null, reportSha256: null };
  }

  setStage('report_reservation');
  const writer = await ports.reserveReport(ports.reportPath);
  let closed = false;
  const close = async (): Promise<void> => {
    if (!closed) {
      closed = true;
      await writer.close();
    }
  };
  const startedAt = ports.now().toISOString();
  let invocationCount = 0;
  try {
    const initialAttempts = groundedBalancedScenarios.map((scenario) => ({ scenarioId: scenario.scenarioId,
      status: 'not_attempted' as const, latencyMs: null, promptTokens: null, generatedTokens: null, correlationComplete: false }));
    const initialObservations = groundedBalancedScenarios.map((scenario) => ({
      scenarioId: scenario.scenarioId, expectedGroundingState: scenario.expectedGroundingState, expected: scenario.expected,
      expectedSourceIdentities: scenario.expectedSourceIdentities, status: 'not_attempted' as const, groundingState: null,
      parsedJson: null, schemaAccepted: null, citationsValid: null, citedExpectedSourceIdentities: [], humanReviewRequired: null,
      correlationComplete: false, failureStage: null, validationReason: null, latencyMs: null, promptTokens: null,
      generatedTokens: null, providerDiagnostics: null,
    }));
    setStage('report_write');
    await writer.write(createAiAssistedExploratoryEvaluationV1Report({ status: 'in_progress', startedAt,
      finishedAt: startedAt, ollamaVersion: prepared.ollamaVersion, source: prepared.source, machineContract: machineContract(),
      attempts: initialAttempts, observations: initialObservations }));

    setStage('provider_evaluation');
    const run = await runGroundedBalancedEvaluation({
      providerFactory: (log) => {
        invocationCount++;
        return ports.providerFactory(prepared, log);
      },
      healthCheck: () => ports.healthCheck(prepared),
      sourcesFor: ports.sourcesFor,
      onProgress: async (attempts, observations) => {
        setStage('report_write');
        await writer.write(createAiAssistedExploratoryEvaluationV1Report({ status: 'in_progress', startedAt,
          finishedAt: ports.now().toISOString(), ollamaVersion: prepared.ollamaVersion, source: prepared.source,
          machineContract: machineContract(), attempts, observations }));
        setStage('provider_evaluation');
      },
    });
    const status = run.stopped || run.attempts.some((item) => item.status === 'not_attempted') ? 'incomplete' : 'completed_exploratory';
    setStage('report_write');
    await writer.write(createAiAssistedExploratoryEvaluationV1Report({ status, startedAt,
      finishedAt: ports.now().toISOString(), ollamaVersion: prepared.ollamaVersion, source: prepared.source,
      machineContract: machineContract(), attempts: run.attempts, observations: run.observations }));
    setStage('report_close');
    await close();
    const sha256 = await ports.reportHash(ports.reportPath);
    const summary = { status, qualificationStatus: 'NOT_QUALIFIED', providerInvocationCount: invocationCount,
      reportPath: ports.reportPath, reportSha256: sha256 };
    ports.output(summary);
    return { status, providerInvocationCount: invocationCount, reportPath: ports.reportPath,
      reportSha256: sha256 };
  } catch {
    try { await close(); } catch { /* Preserve the last durable progress report. */ }
    throw new Error('exploratory_run_failed');
  }
}

async function main(): Promise<void> {
  if (process.argv.length !== 2 || process.env.NODE_ENV !== 'development' ||
      process.env.AEGIS_AI_ASSISTED_EXPLORATORY_V1 !== 'true' || process.env.AEGIS_AI_ENABLED !== 'true' ||
      process.env.AEGIS_GROUNDED_AI_ENABLED !== 'true' || process.env.AEGIS_OLLAMA_MODEL !== contract.model ||
      process.env.AEGIS_AI_TIMEOUT_MS !== String(contract.timeoutMs) || process.env.AEGIS_AI_MAX_CONCURRENT !== '1') {
    throw new Error('exploratory_explicit_local_opt_in_required');
  }
  const result = await runAiAssistedExploratoryOrchestration({
    reportPath,
    onStage: (nextStage) => { stage = nextStage; },
    preflightSource: async () => {
      verifyExploratoryTransport(process.env, process.execArgv, localOllamaGenerateEndpoint);
      const releaseSha = process.env.AEGIS_AI_ASSISTED_EXPLORATORY_RELEASE_SHA ?? '';
      const approvedSource = verifyGroundedAiQualificationV1Source(git, gitBlobSha256, releaseSha);
      const helperBytes = await readFile(fileURLToPath(new URL('./ai-assisted-exploratory-evaluation-v1.ts', import.meta.url)));
      verifyExploratoryContractHelperIdentity(helperBytes, gitBlobBytes(releaseSha, contractHelperRelativePath));
      const runnerSha256 = await reportHash(fileURLToPath(import.meta.url));
      const runnerIdentity = verifyAiAssistedExploratoryRunnerIdentity(git, gitBlobSha256, releaseSha, runnerSha256);
      return { ...approvedSource, exploratoryRunnerSha256: runnerIdentity.runnerSha256,
        exploratoryRunnerReleaseCommit: runnerIdentity.releaseCommit, repositoryBaseCommit: contract.approvedBaseCommit };
    },
    preflightDataset: async () => verifyExploratoryDataset(),
    preflightRuntime: async () => {
      const version = getOllamaVersion();
      if (version !== contract.ollamaVersion) throw new Error('exploratory_ollama_version_mismatch');
      const providerConfig = resolveOllamaConfig(process.env);
      validateExploratoryRuntime(version, providerConfig, localOllamaGenerateEndpoint);
      return { ollamaVersion: version, providerConfig };
    },
    checkReportAvailable: assertExploratoryReportPathAbsent,
    preflightModel: async () => assertModelReady(),
    confirm,
    reserveReport: async (path) => {
      const handle = await reservePrivateReport(path);
      return { write: (report) => replacePrivateReportAtomically(path, report), close: () => handle.close() };
    },
    providerFactory: (prepared, log) => createGroundedOllamaProvider(prepared.providerConfig, { log,
      fetchImpl: async (input, init) => {
        assertNoOtherOllamaClient();
        const response = await fetch(input, init);
        assertNoOtherOllamaClient();
        return response;
      } }),
    healthCheck: async () => { try { await assertModelReady(); return true; } catch { return false; } },
    sourcesFor,
    reportHash,
    now: () => new Date(),
    output: (summary) => {
      if (summary.status === 'cancelled') {
        stdout.write('Exploratory evaluation cancelled before report reservation or provider requests.\n');
      } else stdout.write(`${JSON.stringify(summary)}\n`);
    },
  });
  if (result.status === 'incomplete') process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => { console.error(safeAiAssistedExploratoryFailure(stage)); process.exitCode = 1; });
}

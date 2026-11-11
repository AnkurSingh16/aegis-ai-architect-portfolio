import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { get } from 'node:http';
import { stdin, stdout } from 'node:process';
import { createInterface } from 'node:readline/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { groundedAnalysisSchema, type GroundedSource } from '../grounded-analysis.js';
import { createGroundedOllamaConfidenceContractEvaluationProvider } from '../grounded-provider.js';
import { localOllamaGenerateEndpoint, resolveOllamaConfig, type OllamaConfig } from '../provider.js';
import { assertSafeOllamaTcpRecords, parseOllamaTcpRecords } from './ollama-socket-preflight.js';
import { groundedBalancedDatasetVersion, groundedBalancedLabelStatus, groundedBalancedPlannedAttempts,
  groundedBalancedScenarios, validateGroundedBalancedDataset } from './grounded-balanced-dataset.js';
import { runGroundedBalancedEvaluation, type BalancedAttempt, type BalancedRun } from './grounded-balanced-runner.js';
import { createBalancedObservation, type BalancedObservation } from './grounded-balanced-scoring.js';
import { createGroundedConfidenceContractReport, groundedConfidenceContractReportRelativePath } from './grounded-confidence-contract-report.js';
import { verifyGroundedConfidenceContractEvaluationSource } from './source-identity.js';
import { reservePrivateReport, writePrivateReport } from './private-report.js';

const expectedModel = 'qwen2.5:3b-instruct';
const outputTokenBudget = 512;
const confirmation = 'RUN GROUNDED CONFIDENCE CONTRACT EVALUATION V1';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../../');
const reportPath = resolve(root, groundedConfidenceContractReportRelativePath);
const localOrigin = 'http://127.0.0.1:11434';
const failureStages = ['source_preflight', 'runtime_preflight', 'model_preflight', 'operator_confirmation', 'report_reservation',
  'initial_report_write', 'provider_evaluation', 'progress_report_write', 'final_report_write', 'summary_output', 'report_close', 'unknown'] as const;
type FailureStage = typeof failureStages[number];
let currentStage: FailureStage = 'source_preflight';

export function safeConfidenceContractCliFailure(stage: string): string {
  return JSON.stringify({ event: 'grounded_confidence_contract_evaluation_cli_failure',
    failureStage: failureStages.includes(stage as FailureStage) ? stage : 'unknown' });
}

export function confidenceContractReportExitCode(report: { executionStatus: string; contractAcceptanceStatus: string }): 0 | 1 {
  return report.executionStatus === 'completed' && report.contractAcceptanceStatus === 'passed' ? 0 : 1;
}

/** Reject all known environment- or Node-flag-based proxy routing without exposing values. */
export function assertNoConfidenceContractProxy(env: NodeJS.ProcessEnv, execArgv: readonly string[] = []): void {
  const proxyVariables = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy'];
  const nodeProxyEnabled = ['1', 'true', 'yes'].includes((env.NODE_USE_ENV_PROXY ?? '').trim().toLowerCase());
  const proxyFlag = (argument: string): boolean => argument === '--use-env-proxy' || argument.startsWith('--use-env-proxy=');
  const nodeOptionsProxy = (env.NODE_OPTIONS ?? '').split(/\s+/).filter(Boolean).some(proxyFlag);
  const proxyVariablePresent = proxyVariables.some((name) => Boolean(env[name]?.trim()));
  if (proxyVariablePresent || nodeProxyEnabled || nodeOptionsProxy || execArgv.some(proxyFlag)) {
    throw new Error('proxy_configuration_not_allowed');
  }
}

export function assertApprovedConfidenceContractRuntime(config: OllamaConfig | undefined): asserts config is OllamaConfig {
  if (!config || config.model !== expectedModel || config.timeoutMs !== 15000 || config.maxConcurrent !== 1 ||
      localOllamaGenerateEndpoint !== 'http://127.0.0.1:11434/api/generate' || groundedBalancedPlannedAttempts !== 6 ||
      groundedBalancedScenarios.length !== 6 || groundedAnalysisSchema.oneOf.length !== 2 || outputTokenBudget !== 512) {
    throw new Error('approved_contract_unavailable');
  }
}

function assertNoActiveClient(): void {
  const records = execFileSync('/usr/sbin/lsof', ['-nP', '-FpcnT', '-iTCP:11434'],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  assertSafeOllamaTcpRecords(parseOllamaTcpRecords(records), process.pid);
}

async function localJson(path: '/api/tags' | '/api/ps'): Promise<unknown> {
  return await new Promise((resolveValue, reject) => {
    const request = get(`${localOrigin}${path}`, { agent: false, headers: { connection: 'close' } }, (response) => {
      const chunks: Buffer[] = [];
      let bytes = 0;
      response.on('data', (chunk: Buffer) => {
        bytes += chunk.byteLength;
        if (bytes > 32 * 1024) { request.destroy(); reject(new Error('health_bound')); return; }
        chunks.push(chunk);
      });
      response.on('end', () => {
        if (response.statusCode !== 200) { reject(new Error('health_status')); return; }
        try { resolveValue(JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown); }
        catch { reject(new Error('health_json')); }
      });
    });
    request.setTimeout(3000, () => request.destroy(new Error('health_timeout')));
    request.on('error', () => reject(new Error('health_request')));
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function assertModelReady(): Promise<void> {
  assertNoActiveClient();
  const [tags, ps] = await Promise.all([localJson('/api/tags'), localJson('/api/ps')]);
  if (!isRecord(tags) || !Array.isArray(tags.models) || !tags.models.some((item) => isRecord(item) && item.name === expectedModel) ||
      !isRecord(ps) || !Array.isArray(ps.models)) throw new Error('approved_model_unavailable');
  assertNoActiveClient();
}

async function confirmRun(): Promise<boolean> {
  if (!stdin.isTTY || !stdout.isTTY) throw new Error('interactive_terminal_required');
  const prompt = createInterface({ input: stdin, output: stdout });
  try { return await prompt.question(`This is one six-case confidence-contract diagnostic. Type ${confirmation} to continue: `) === confirmation; }
  finally { prompt.close(); }
}

function sourcesFor(scenario: typeof groundedBalancedScenarios[number]): { tenant: typeof scenario.tenant; sources: GroundedSource[] } {
  return { tenant: scenario.tenant, sources: scenario.sources.map((source) => ({ citationId: randomUUID(), title: source.title,
    sourceIdentity: source.sourceIdentity, version: source.version, position: 0, content: source.content })) };
}

function fillPendingRun(attempts: readonly BalancedAttempt[], observations: readonly BalancedObservation[]): BalancedRun {
  const attemptRows = [...attempts];
  const observationRows = [...observations];
  for (const scenario of groundedBalancedScenarios) {
    if (!observationRows.some((item) => item.scenarioId === scenario.scenarioId)) observationRows.push(createBalancedObservation(scenario, 'not_attempted'));
    if (!attemptRows.some((item) => item.scenarioId === scenario.scenarioId)) {
      attemptRows.push({ scenarioId: scenario.scenarioId, status: 'not_attempted', latencyMs: null, promptTokens: null,
        generatedTokens: null, correlationComplete: false });
    }
  }
  return { attempts: groundedBalancedScenarios.map((scenario) => attemptRows.find((item) => item.scenarioId === scenario.scenarioId)!),
    observations: groundedBalancedScenarios.map((scenario) => observationRows.find((item) => item.scenarioId === scenario.scenarioId)!), stopped: false };
}

async function main(): Promise<void> {
  if (process.argv.length !== 2) throw new Error('unsupported_arguments');
  const source = verifyGroundedConfidenceContractEvaluationSource((args) => execFileSync('git', [...args],
    { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim());
  currentStage = 'runtime_preflight';
  if (process.env.NODE_ENV !== 'development' || process.env.AEGIS_AI_ENABLED !== 'true' ||
      process.env.AEGIS_GROUNDED_AI_ENABLED !== 'true') throw new Error('explicit_local_opt_in_required');
  assertNoConfidenceContractProxy(process.env, process.execArgv);
  const config = resolveOllamaConfig(process.env);
  validateGroundedBalancedDataset();
  assertApprovedConfidenceContractRuntime(config);
  currentStage = 'model_preflight';
  await assertModelReady();
  currentStage = 'operator_confirmation';
  if (!await confirmRun()) { stdout.write('Confidence-contract evaluation cancelled before a provider request.\n'); return; }

  const identity = { datasetVersion: groundedBalancedDatasetVersion, labelStatus: groundedBalancedLabelStatus, source };
  currentStage = 'report_reservation';
  const handle = await reservePrivateReport(reportPath);
  let failed = false;
  try {
    currentStage = 'initial_report_write';
    await writePrivateReport(handle, createGroundedConfidenceContractReport({ ...identity, run: fillPendingRun([], []) }));
    currentStage = 'provider_evaluation';
    const run = await runGroundedBalancedEvaluation({
      providerFactory: (log) => createGroundedOllamaConfidenceContractEvaluationProvider(config, { log }),
      healthCheck: async () => { try { await assertModelReady(); return true; } catch { return false; } },
      sourcesFor,
      onProgress: async (attempts, observations) => {
        currentStage = 'progress_report_write';
        await writePrivateReport(handle, createGroundedConfidenceContractReport({ ...identity,
          run: fillPendingRun(attempts, observations) }));
        currentStage = 'provider_evaluation';
      },
    });
    currentStage = 'final_report_write';
    const report = createGroundedConfidenceContractReport({ ...identity, run });
    await writePrivateReport(handle, report);
    currentStage = 'summary_output';
    stdout.write(`${JSON.stringify({ evaluatorVersion: report.evaluatorVersion, reportSchemaVersion: report.reportSchemaVersion,
      ...source, promptVariant: report.promptVariant, generation: report.generation,
      executionStatus: report.executionStatus, contractAcceptanceStatus: report.contractAcceptanceStatus,
      decisionQualityStatus: report.decisionQualityStatus, attempted: report.score.attempted,
      succeeded: report.score.succeeded, failed: report.score.failed, notAttempted: report.score.notAttempted,
      reportPath: groundedConfidenceContractReportRelativePath })}\n`);
    process.exitCode = confidenceContractReportExitCode(report);
  } catch { failed = true; }
  try { await handle.close(); }
  catch { if (!failed) currentStage = 'report_close'; failed = true; }
  if (failed) throw new Error('evaluation_failed');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => { console.error(safeConfidenceContractCliFailure(currentStage)); process.exitCode = 1; });
}

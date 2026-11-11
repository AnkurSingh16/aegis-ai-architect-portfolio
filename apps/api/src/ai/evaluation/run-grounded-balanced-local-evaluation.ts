import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { get } from 'node:http';
import { stdin, stdout } from 'node:process';
import { createInterface } from 'node:readline/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { groundedAnalysisSchema, type GroundedSource } from '../grounded-analysis.js';
import { createGroundedOllamaProvider } from '../grounded-provider.js';
import { localOllamaGenerateEndpoint, resolveOllamaConfig } from '../provider.js';
import { assertSafeOllamaTcpRecords, parseOllamaTcpRecords } from './ollama-socket-preflight.js';
import { groundedBalancedDatasetVersion, groundedBalancedLabelStatus, groundedBalancedPlannedAttempts,
  groundedBalancedScenarios, validateGroundedBalancedDataset } from './grounded-balanced-dataset.js';
import { runGroundedBalancedEvaluation, type BalancedAttempt } from './grounded-balanced-runner.js';
import { scoreGroundedBalancedEvaluation } from './grounded-balanced-scoring.js';
import { verifyGroundedBalancedEvaluationSource } from './source-identity.js';
import { reservePrivateReport, writePrivateReport } from './private-report.js';

const expectedModel = 'qwen2.5:3b-instruct';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../../');
export const groundedBalancedReportRelativePath = '.local/evaluations/milestone-4.12-grounded-balanced-qwen2.5-3b-instruct-v1.json';
const reportPath = resolve(root, groundedBalancedReportRelativePath);
const localOrigin = 'http://127.0.0.1:11434';
const cliStages = ['source_preflight', 'runtime_preflight', 'model_preflight', 'operator_confirmation', 'report_reservation',
  'initial_report_write', 'provider_evaluation', 'progress_report_write', 'final_report_write', 'summary_output', 'report_close', 'unknown'] as const;
type CliStage = typeof cliStages[number];
let cliStage: CliStage = 'source_preflight';

export function safeBalancedCliFailure(stage: string): string {
  return JSON.stringify({ event: 'grounded_balanced_evaluation_cli_failure', failureStage: cliStages.includes(stage as CliStage) ? stage : 'unknown' });
}

function assertNoActiveClient(): void {
  const records = execFileSync('/usr/sbin/lsof', ['-nP', '-FpcnT', '-iTCP:11434'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
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
  if (!isRecord(tags) || !Array.isArray(tags.models) || !tags.models.some((model) => isRecord(model) && model.name === expectedModel) ||
      !isRecord(ps) || !Array.isArray(ps.models)) throw new Error('approved_model_unavailable');
  assertNoActiveClient();
}

async function confirmRun(): Promise<boolean> {
  if (!stdin.isTTY || !stdout.isTTY) throw new Error('interactive_terminal_required');
  const prompt = createInterface({ input: stdin, output: stdout });
  try {
    return await prompt.question('This runs at most six distinct synthetic evaluations. Type RUN SIX BALANCED GROUNDED EVALUATIONS to continue: ')
      === 'RUN SIX BALANCED GROUNDED EVALUATIONS';
  } finally { prompt.close(); }
}

function sourcesFor(scenario: typeof groundedBalancedScenarios[number]): { tenant: typeof scenario.tenant; sources: GroundedSource[] } {
  return { tenant: scenario.tenant, sources: scenario.sources.map((source) => ({ citationId: randomUUID(), title: source.title,
    sourceIdentity: source.sourceIdentity, version: source.version, position: 0, content: source.content })) };
}

function safeAttempts(attempts: readonly BalancedAttempt[]) {
  return attempts.map((attempt) => ({ scenarioId: attempt.scenarioId, status: attempt.status,
    ...(attempt.groundingState ? { groundingState: attempt.groundingState } : {}),
    ...(attempt.category ? { category: attempt.category } : {}), ...(attempt.priority ? { priority: attempt.priority } : {}),
    ...(attempt.recommendedTeam ? { recommendedTeam: attempt.recommendedTeam } : {}), ...(attempt.nextAction ? { nextAction: attempt.nextAction } : {}),
    ...(attempt.citationCount === undefined ? {} : { citationCount: attempt.citationCount }),
    ...(attempt.humanReviewRequired === undefined ? {} : { humanReviewRequired: attempt.humanReviewRequired }),
    ...(attempt.failureStage ? { failureStage: attempt.failureStage } : {}),
    ...(attempt.validationReason ? { validationReason: attempt.validationReason } : {}),
    latencyMs: attempt.latencyMs, promptTokens: attempt.promptTokens, generatedTokens: attempt.generatedTokens,
    correlationComplete: attempt.correlationComplete }));
}

async function main(): Promise<void> {
  if (process.argv.length !== 2) throw new Error('unsupported_arguments');
  const source = verifyGroundedBalancedEvaluationSource((args) => execFileSync('git', [...args],
    { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim());
  cliStage = 'runtime_preflight';
  if (process.env.NODE_ENV !== 'development' || process.env.AEGIS_AI_ENABLED !== 'true' ||
      process.env.AEGIS_GROUNDED_AI_ENABLED !== 'true') throw new Error('explicit_local_opt_in_required');
  const config = resolveOllamaConfig(process.env);
  validateGroundedBalancedDataset();
  if (!config || config.model !== expectedModel || config.timeoutMs !== 15000 || config.maxConcurrent !== 1 ||
      localOllamaGenerateEndpoint !== 'http://127.0.0.1:11434/api/generate' || groundedBalancedPlannedAttempts !== 6 ||
      groundedBalancedScenarios.length !== 6 || groundedAnalysisSchema.oneOf.length !== 2) throw new Error('approved_contract_unavailable');
  cliStage = 'model_preflight';
  await assertModelReady();
  cliStage = 'operator_confirmation';
  if (!await confirmRun()) { stdout.write('Balanced evaluation cancelled before any provider request.\n'); return; }

  const identity = { datasetVersion: groundedBalancedDatasetVersion, labelStatus: groundedBalancedLabelStatus,
    ...source, model: expectedModel, plannedAttempts: 6, testMode: 'provider-level-local-synthetic-not-authenticated-http-e2e',
    limitations: ['Six independent authored synthetic scenarios are a bounded smoke evaluation, not production accuracy evidence.',
      'Labels are engineering-reviewed and are not human-approved ground truth.',
      'Citation identity and expected-source coverage do not prove semantic entailment; independent semantic review is NOT MEASURED.',
      'Provider-level execution does not validate Auth0, membership, RLS, or authenticated HTTP behavior.',
      'All recommendations remain advisory and require human review; no support action is executed.',
      'No prompts, case facts, source content, label rationales, raw responses, credentials, or rejected model output are stored.'] };
  cliStage = 'report_reservation';
  const handle = await reservePrivateReport(reportPath);
  let failed = false;
  try {
    cliStage = 'initial_report_write';
    await writePrivateReport(handle, { ...identity, status: 'in_progress', attempts: [], score: scoreGroundedBalancedEvaluation([]) });
    cliStage = 'provider_evaluation';
    const run = await runGroundedBalancedEvaluation({
      providerFactory: (log) => createGroundedOllamaProvider(config, { log }),
      healthCheck: async () => { try { await assertModelReady(); return true; } catch { return false; } },
      sourcesFor,
      onProgress: async (attempts, observations) => {
        cliStage = 'progress_report_write';
        await writePrivateReport(handle, { ...identity, status: 'in_progress', attempts: safeAttempts(attempts),
          score: scoreGroundedBalancedEvaluation(observations) });
        cliStage = 'provider_evaluation';
      },
    });
    const score = scoreGroundedBalancedEvaluation(run.observations);
    const status = run.stopped || score.notAttempted > 0 ? 'stopped' : 'completed';
    cliStage = 'final_report_write';
    await writePrivateReport(handle, { ...identity, status, attempts: safeAttempts(run.attempts), score });
    cliStage = 'summary_output';
    stdout.write(`${JSON.stringify({ status, datasetVersion: groundedBalancedDatasetVersion, ...source,
      planned: 6, attempted: score.attempted, succeeded: score.succeeded, failed: score.failed,
      notAttempted: score.notAttempted, reportPath: groundedBalancedReportRelativePath })}\n`);
    process.exitCode = status === 'completed' ? 0 : 1;
  } catch { failed = true; }
  try { await handle.close(); }
  catch { if (!failed) cliStage = 'report_close'; failed = true; }
  if (failed) throw new Error('evaluation_failed');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => { console.error(safeBalancedCliFailure(cliStage)); process.exitCode = 1; });
}

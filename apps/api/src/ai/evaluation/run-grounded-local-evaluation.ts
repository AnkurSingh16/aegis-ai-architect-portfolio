import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { get } from 'node:http';
import { stdin, stdout } from 'node:process';
import { createInterface } from 'node:readline/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveGroundedContextSource, groundedContextDatasetVersion, groundedContextLabelStatus, groundedContextSlots } from './grounded-context-dataset.js';
import { groundedAnalysisSchema, parseGroundedProviderOutput, type GroundedSource } from '../grounded-analysis.js';
import { createGroundedOllamaProvider } from '../grounded-provider.js';
import { resolveOllamaConfig } from '../provider.js';
import { scoreGroundedContextEvaluation } from './grounded-context-scoring.js';
import { runGroundedContextEvaluation } from './grounded-context-runner.js';
import { verifyGroundedContextEvaluationSource } from './source-identity.js';
import { reservePrivateReport, writePrivateReport } from './private-report.js';
import { assertSafeOllamaTcpRecords, parseOllamaTcpRecords } from './ollama-socket-preflight.js';

const expectedModel = 'qwen2.5:3b-instruct';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../../');
export const groundedEvaluationV3ReportRelativePath = '.local/evaluations/milestone-4.8-grounded-qwen2.5-3b-instruct-v3.json';
export const groundedEvaluationV1ReportRelativePath = '.local/evaluations/milestone-4-grounded-qwen2.5-3b-instruct.json';
export const groundedEvaluationV2ReportRelativePath = '.local/evaluations/milestone-4.7-grounded-qwen2.5-3b-instruct-v2.json';
export const groundedContextEvaluationReportRelativePath = '.local/evaluations/milestone-4.11-grounded-context-qwen2.5-3b-instruct-v1.json';
const reportPath = resolve(root, groundedContextEvaluationReportRelativePath);
const localOrigin = 'http://127.0.0.1:11434';
const cliFailureStages = ['source_preflight', 'runtime_preflight', 'model_preflight', 'operator_confirmation', 'report_reservation',
  'initial_report_write', 'provider_evaluation', 'progress_report_write', 'final_report_write', 'summary_output', 'report_close', 'unknown'] as const;
type CliFailureStage = typeof cliFailureStages[number];
let cliFailureStage: CliFailureStage = 'source_preflight';

export function sanitizedCliFailure(stage: string): string {
  const failureStage = cliFailureStages.includes(stage as CliFailureStage) ? stage as CliFailureStage : 'unknown';
  return JSON.stringify({ event: 'grounded_evaluation_cli_failure', failureStage });
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
        if (bytes > 32 * 1024) { request.destroy(); reject(new Error('Local model health response exceeded its bound.')); return; }
        chunks.push(chunk);
      });
      response.on('end', () => {
        if (response.statusCode !== 200) { reject(new Error('Local model health check failed.')); return; }
        try { resolveValue(JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown); }
        catch { reject(new Error('Local model health response was invalid.')); }
      });
    });
    request.setTimeout(3000, () => request.destroy(new Error('Local model health check timed out.')));
    request.on('error', () => reject(new Error('Local model health check failed.')));
  });
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
async function assertModelReady(): Promise<void> {
  assertNoActiveClient();
  const [tags, ps] = await Promise.all([localJson('/api/tags'), localJson('/api/ps')]);
  if (!isRecord(tags) || !Array.isArray(tags.models) || !tags.models.some((model) => isRecord(model) && model.name === expectedModel) ||
      !isRecord(ps) || !Array.isArray(ps.models)) throw new Error('Approved local model is unavailable.');
  assertNoActiveClient();
}
async function confirmRun(): Promise<boolean> {
  if (!stdin.isTTY || !stdout.isTTY) throw new Error('A visible interactive terminal is required for grounded local evaluation.');
  const prompt = createInterface({ input: stdin, output: stdout });
  try { return await prompt.question('This runs at most six synthetic provider evaluations. Type RUN SIX GROUNDED EVALUATIONS to continue: ') === 'RUN SIX GROUNDED EVALUATIONS'; }
  finally { prompt.close(); }
}
function inMemorySources(slot: typeof groundedContextSlots[number]): { tenant: typeof slot.tenant; sources: GroundedSource[] } {
  const document = resolveGroundedContextSource(slot);
  return { tenant: document.tenant, sources: [{ citationId: randomUUID(), title: document.title, sourceIdentity: document.sourceIdentity,
    version: document.version, position: 0, content: document.content }] };
}

async function main(): Promise<void> {
  if (process.argv.length !== 2) throw new Error('Grounded evaluation accepts no command-line arguments.');
  const source = verifyGroundedContextEvaluationSource((args) => execFileSync('git', [...args],
    { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim());
  cliFailureStage = 'runtime_preflight';
  if (process.env.NODE_ENV !== 'development' || process.env.AEGIS_AI_ENABLED !== 'true' || process.env.AEGIS_GROUNDED_AI_ENABLED !== 'true') {
    throw new Error('Grounded evaluation requires explicit local development opt-in.');
  }
  const config = resolveOllamaConfig(process.env);
  if (!config || config.model !== expectedModel || config.timeoutMs !== 15000 || config.maxConcurrent !== 1 ||
      groundedContextSlots.length !== 6 || new Set(groundedContextSlots.map((slot) => slot.slotId)).size !== 6 ||
      groundedAnalysisSchema.oneOf.some((branch) => branch.properties.humanReviewRequired.enum[0] !== true) ||
      typeof parseGroundedProviderOutput !== 'function') {
    throw new Error('Grounded evaluation contract or approved limits are unavailable.');
  }
  if (groundedContextSlots.some((slot) => !slot.caseFacts || !slot.expectedGroundingState || !slot.sourceIdentity)) {
    throw new Error('Grounded context evaluation plan is incomplete.');
  }
  cliFailureStage = 'model_preflight';
  await assertModelReady();
  cliFailureStage = 'operator_confirmation';
  if (!await confirmRun()) { stdout.write('Grounded evaluation cancelled before any model request.\n'); return; }

  const timestamp = new Date().toISOString();
  const base = { datasetVersion: groundedContextDatasetVersion, ...source, model: expectedModel, evaluationTimestamp: timestamp,
    testMode: 'provider-level-in-memory-synthetic-not-authenticated-http-e2e', plannedSlots: 6,
    labelStatus: groundedContextLabelStatus, status: 'in_progress' as const,
    limitations: ['Three synthetic case types with paired observations are repeated provider observations, not independent cases or production accuracy evidence.',
      'Provider-level in-memory execution does not validate Auth0, membership, RLS, or HTTP request correlation.',
      'Citation identity and evidence coverage are deterministic checks, not proof that claims are semantically entailed.',
      'Current case/source combinations are expected to abstain because severity/team criteria, billing comparison fields, or the guide location are absent.',
      'Production StoredCase does not contain a narrative; this evaluation uses only the approved synthetic description and does not fabricate production facts.',
      'No prompts, case facts, source text, review rationales, raw responses, credentials, or rejected model output are stored.'] };
  cliFailureStage = 'report_reservation';
  const handle = await reservePrivateReport(reportPath);
  let failed = false;
  try {
    cliFailureStage = 'initial_report_write';
    await writePrivateReport(handle, { ...base, attempts: [], score: scoreGroundedContextEvaluation([]) });
    cliFailureStage = 'provider_evaluation';
    const run = await runGroundedContextEvaluation({
      providerFactory: (log) => createGroundedOllamaProvider(config, { log }),
      healthCheck: async () => { try { await assertModelReady(); return true; } catch { return false; } },
      sourcesFor: inMemorySources,
      onProgress: async (attempts, observations) => {
        cliFailureStage = 'progress_report_write';
        await writePrivateReport(handle, { ...base, status: 'in_progress', attempts, score: scoreGroundedContextEvaluation(observations) });
        cliFailureStage = 'provider_evaluation';
      },
    });
    const score = scoreGroundedContextEvaluation(run.observations);
    const status = run.stopped || score.notAttempted > 0 ? 'stopped' : 'completed';
    const exitCode = status === 'completed' ? 0 : 1;
    cliFailureStage = 'final_report_write';
    await writePrivateReport(handle, { ...base, status, attempts: run.attempts, score });
    cliFailureStage = 'summary_output';
    stdout.write(`${JSON.stringify({ status, model: expectedModel, ...source, planned: 6, attempted: score.attempted,
      succeeded: score.succeeded, failed: score.failed, notAttempted: score.notAttempted, reportPath: groundedContextEvaluationReportRelativePath })}\n`);
    process.exitCode = exitCode;
  } catch { failed = true; }
  try { await handle.close(); }
  catch {
    if (!failed) cliFailureStage = 'report_close';
    failed = true;
  }
  if (failed) throw new Error('evaluation_failed');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => { console.error(sanitizedCliFailure(cliFailureStage)); process.exitCode = 1; });
}

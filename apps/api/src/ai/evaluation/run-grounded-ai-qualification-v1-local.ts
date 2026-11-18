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
import { assertSafeOllamaTcpRecords, parseOllamaTcpRecords } from './ollama-socket-preflight.js';
import { assertNoDiagnosticProxy } from './run-grounded-supported-output-diagnostic-local.js';
import { groundedBalancedScenarios, validateGroundedBalancedDataset } from './grounded-balanced-dataset.js';
import { runGroundedBalancedEvaluation } from './grounded-balanced-runner.js';
import { createBalancedObservation } from './grounded-balanced-scoring.js';
import { reservePrivateReport, writePrivateReport } from './private-report.js';
import {
  createGroundedAiQualificationV1Report,
  evaluateGroundedAiQualificationV1,
  groundedAiQualificationV1Contract as contract,
  groundedAiQualificationV1DatasetSha256,
  groundedAiQualificationV1ReportRelativePath,
  verifyGroundedAiQualificationV1Source,
  type QualificationV1ReviewEvidence,
} from './grounded-ai-qualification-v1.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../../');
const reportPath = resolve(root, groundedAiQualificationV1ReportRelativePath);
const datasetReviewPath = resolve(root, '.local/operator/grounded-ai-qualification-v1-dataset-review.json');
const confirmation = 'RUN GROUNDED AI QUALIFICATION V1';
const failureStages = ['source_preflight', 'dataset_review', 'configuration', 'model_preflight', 'operator_confirmation',
  'report_reservation', 'provider_evaluation', 'report_write', 'report_close', 'unknown'] as const;
type FailureStage = typeof failureStages[number];
let stage: FailureStage = 'source_preflight';

function sanitizedFailure(stageName: string): string {
  const safeStage = failureStages.includes(stageName as FailureStage) ? stageName : 'unknown';
  return JSON.stringify({ event: 'grounded_ai_qualification_v1_failed', failureStage: safeStage });
}

function git(args: readonly string[]): string {
  return execFileSync('git', [...args], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
}

function gitBlobSha256(ref: string, filePath: string): string {
  const bytes = execFileSync('git', ['show', `${ref}:${filePath}`], { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] });
  return createHash('sha256').update(bytes).digest('hex');
}

export function assertQualificationV1LocalTransport(env: NodeJS.ProcessEnv, execArgv: readonly string[], endpoint: string): void {
  assertNoDiagnosticProxy(env, execArgv);
  if (endpoint !== contract.endpoint) throw new Error('non_loopback_endpoint');
}

function assertNoProxy(): void {
  assertQualificationV1LocalTransport(process.env, process.execArgv, localOllamaGenerateEndpoint);
}

function assertNoOtherOllamaClient(): void {
  const records = execFileSync('/usr/sbin/lsof', ['-nP', '-FpcnT', '-iTCP:11434'], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
  });
  assertSafeOllamaTcpRecords(parseOllamaTcpRecords(records), process.pid);
}

function localJson(path: '/api/tags' | '/api/ps'): Promise<unknown> {
  return new Promise((resolveValue, reject) => {
    const request = get(`http://127.0.0.1:11434${path}`, { agent: false, headers: { connection: 'close' } }, (response) => {
      const chunks: Buffer[] = [];
      let bytes = 0;
      response.on('data', (chunk: Buffer) => {
        bytes += chunk.byteLength;
        if (bytes > 32 * 1024) { request.destroy(); reject(new Error('health_response_too_large')); return; }
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

export function parseGroundedAiQualificationV1DatasetReview(value: unknown): QualificationV1ReviewEvidence['datasetReview'] {
  const expectedScenarioIds = groundedBalancedScenarios.map((scenario) => scenario.scenarioId).sort();
  if (!isRecord(value) || Object.keys(value).sort().join(',') !== 'adjudication,datasetSha256,reviewers,schemaVersion' ||
      value.schemaVersion !== 'aegis-grounded-ai-dataset-review-v1' ||
      value.datasetSha256 !== groundedAiQualificationV1DatasetSha256() || value.adjudication !== 'approved' ||
      !Array.isArray(value.reviewers) || value.reviewers.length !== 2) throw new Error('dataset_review_invalid');
  const reviewers = value.reviewers;
  const ids = new Set<string>();
  for (const reviewer of reviewers) {
    if (!isRecord(reviewer) || Object.keys(reviewer).sort().join(',') !== 'datasetSha256,reviewerId,scenarioReviews' ||
        typeof reviewer.reviewerId !== 'string' || !/^[A-Z0-9_-]{4,40}$/.test(reviewer.reviewerId) ||
        reviewer.datasetSha256 !== groundedAiQualificationV1DatasetSha256() || !Array.isArray(reviewer.scenarioReviews) ||
        reviewer.scenarioReviews.length !== expectedScenarioIds.length || ids.has(reviewer.reviewerId)) {
      throw new Error('dataset_review_invalid');
    }
    const reviewedIds = new Set<string>();
    for (const item of reviewer.scenarioReviews) {
      const expectedScenario = isRecord(item) && typeof item.scenarioId === 'string'
        ? groundedBalancedScenarios.find((scenario) => scenario.scenarioId === item.scenarioId) : undefined;
      if (!isRecord(item) || Object.keys(item).sort().join(',') !==
          'abstentionJustified,classificationFields,decision,expectedGroundingState,expectedSourceIdentities,scenarioId' ||
          item.decision !== 'approve' || !expectedScenario || !expectedScenarioIds.includes(expectedScenario.scenarioId) ||
          reviewedIds.has(expectedScenario.scenarioId) || item.expectedGroundingState !== expectedScenario.expectedGroundingState ||
          !isRecord(item.classificationFields) ||
          Object.keys(item.classificationFields).sort().join(',') !== 'category,nextAction,priority,recommendedTeam' ||
          !Array.isArray(item.expectedSourceIdentities) || item.expectedSourceIdentities.some((id) => typeof id !== 'string')) {
        throw new Error('dataset_review_invalid');
      }
      const fields = item.classificationFields;
      const expectedSources = [...expectedScenario.expectedSourceIdentities].sort();
      const suppliedSources = (item.expectedSourceIdentities as string[]).sort();
      const sourcesMatch = expectedSources.length === suppliedSources.length && expectedSources.every((id, index) => id === suppliedSources[index]);
      if (!sourcesMatch) throw new Error('dataset_review_invalid');
      if (expectedScenario.expectedGroundingState === 'SUPPORTED') {
        if (item.abstentionJustified !== null || Object.values(fields).some((value) => value !== true)) {
          throw new Error('dataset_review_invalid');
        }
      } else if (item.abstentionJustified !== true || Object.values(fields).some((value) => value !== null)) {
        throw new Error('dataset_review_invalid');
      }
      reviewedIds.add(expectedScenario.scenarioId);
    }
    if (reviewedIds.size !== expectedScenarioIds.length) throw new Error('dataset_review_invalid');
    ids.add(reviewer.reviewerId);
  }
  return { datasetSha256: groundedAiQualificationV1DatasetSha256(), attestationCount: ids.size,
    manifestClaimsApproval: true, independentlyVerified: false };
}

async function readDatasetReview(): Promise<QualificationV1ReviewEvidence['datasetReview']> {
  const localDirectory = resolve(root, '.local');
  const operatorDirectory = resolve(root, '.local/operator');
  const localInfo = await lstat(localDirectory);
  if (localInfo.isSymbolicLink() || !localInfo.isDirectory() || (localInfo.mode & 0o077) !== 0) {
    throw new Error('dataset_review_parent_unsafe');
  }
  const directoryInfo = await lstat(operatorDirectory);
  if (directoryInfo.isSymbolicLink() || !directoryInfo.isDirectory() || (directoryInfo.mode & 0o077) !== 0) {
    throw new Error('dataset_review_directory_unsafe');
  }
  const info = await lstat(datasetReviewPath);
  if (info.isSymbolicLink() || !info.isFile() || (info.mode & 0o777) !== 0o600 || info.size > 4096) {
    throw new Error('dataset_review_file_unsafe');
  }
  let parsed: unknown;
  try { parsed = JSON.parse(await readFile(datasetReviewPath, 'utf8')) as unknown; }
  catch { throw new Error('dataset_review_invalid'); }
  return parseGroundedAiQualificationV1DatasetReview(parsed);
}

function safeReviewEvidence(datasetReview: QualificationV1ReviewEvidence['datasetReview']): QualificationV1ReviewEvidence {
  return { datasetReview: { ...datasetReview, independentlyVerified: false },
    semanticReview: { independentReviewerCount: 0, complete: false, entailmentFailures: 0 } };
}

async function assertModelReady(allowQualificationModelLoaded: boolean): Promise<void> {
  assertNoOtherOllamaClient();
  const [tags, ps] = await Promise.all([localJson('/api/tags'), localJson('/api/ps')]);
  if (!isRecord(tags) || !Array.isArray(tags.models) || !tags.models.some((model) => isRecord(model) &&
      model.name === contract.model && model.digest === contract.modelManifestDigest) || !isRecord(ps) || !Array.isArray(ps.models)) {
    throw new Error('approved_model_unavailable');
  }
  const loadedModels = ps.models;
  if ((!allowQualificationModelLoaded && loadedModels.length !== 0) || loadedModels.some((model) =>
      !isRecord(model) || (model.name !== contract.model && model.model !== contract.model))) {
    throw new Error('competing_model_loaded');
  }
  assertNoOtherOllamaClient();
}

function ollamaVersion(): string {
  const output = execFileSync('ollama', ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  const match = output.match(/\b(\d+\.\d+\.\d+)\b/);
  return match?.[1] ?? '';
}

async function confirm(): Promise<boolean> {
  if (!stdin.isTTY || !stdout.isTTY) throw new Error('interactive_terminal_required');
  const prompt = createInterface({ input: stdin, output: stdout });
  try { return await prompt.question(`This evaluation makes at most six local requests. Type ${confirmation}: `) === confirmation; }
  finally { prompt.close(); }
}

function sourcesFor(scenario: typeof groundedBalancedScenarios[number]) {
  return { tenant: scenario.tenant, sources: scenario.sources.map((source) => ({ citationId: randomUUID(),
    title: source.title, sourceIdentity: source.sourceIdentity, version: source.version, position: 0, content: source.content })) };
}

async function sha256File(path: string): Promise<string> {
  return createHash('sha256').update(await readFile(path)).digest('hex');
}

async function main(): Promise<void> {
  if (process.argv.length !== 2 || process.env.NODE_ENV !== 'development' || process.env.AEGIS_AI_ENABLED !== 'true' ||
      process.env.AEGIS_GROUNDED_AI_ENABLED !== 'true' || process.env.AEGIS_OLLAMA_MODEL !== contract.model ||
      process.env.AEGIS_AI_TIMEOUT_MS !== String(contract.timeoutMs) || process.env.AEGIS_AI_MAX_CONCURRENT !== '1') {
    throw new Error('explicit_local_opt_in_required');
  }
  const expectedReleaseSha = process.env.AEGIS_GROUNDED_QUALIFICATION_RELEASE_SHA ?? '';
  const source = verifyGroundedAiQualificationV1Source(git, gitBlobSha256, expectedReleaseSha);
  validateGroundedBalancedDataset();
  stage = 'dataset_review';
  const reportExists = await lstat(reportPath).then(() => true, (error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return false;
    throw error;
  });
  if (reportExists) throw new Error('report_path_occupied');
  const datasetReview = await readDatasetReview();
  stage = 'configuration';
  assertNoProxy();
  const version = ollamaVersion();
  if (version !== contract.ollamaVersion) throw new Error('ollama_version_mismatch');
  const config = resolveOllamaConfig(process.env);
  if (!config || config.model !== contract.model || config.timeoutMs !== contract.timeoutMs || config.maxConcurrent !== 1 ||
      localOllamaGenerateEndpoint !== contract.endpoint || contract.numPredict !== 256 || contract.retryCount !== 0) {
    throw new Error('frozen_runtime_contract_mismatch');
  }
  stage = 'model_preflight';
  await assertModelReady(false);
  stage = 'operator_confirmation';
  if (!await confirm()) return;

  stage = 'report_reservation';
  const handle = await reservePrivateReport(reportPath);
  const startedAt = new Date().toISOString();
  const reviewEvidence = safeReviewEvidence(datasetReview);
  const notAttempted = groundedBalancedScenarios.map((scenario) => createBalancedObservation(scenario, 'not_attempted'));
  const initialEvaluation = evaluateGroundedAiQualificationV1(notAttempted, reviewEvidence);
  const reportInput = (evaluation: ReturnType<typeof evaluateGroundedAiQualificationV1>, finishedAt: string,
    status: 'in_progress' | 'inconclusive' | 'completed_pending_semantic_review') =>
    createGroundedAiQualificationV1Report({ source, status, startedAt, finishedAt, ollamaVersion: version,
      modelManifestDigest: contract.modelManifestDigest,
      promptTemplateSha256: source.protectedFileSha256['apps/api/src/ai/grounded-provider.ts']!,
      reviewEvidence, evaluation });
  try {
    stage = 'report_write';
    await writePrivateReport(handle, reportInput(initialEvaluation, startedAt, 'in_progress'));
    stage = 'provider_evaluation';
    const run = await runGroundedBalancedEvaluation({
      providerFactory: (log) => createGroundedOllamaProvider(config, {
        log,
        fetchImpl: async (input, init) => {
          assertNoOtherOllamaClient();
          const response = await fetch(input, init);
          assertNoOtherOllamaClient();
          return response;
        },
      }),
      healthCheck: async () => { try { await assertModelReady(true); return true; } catch { return false; } },
      sourcesFor,
      onProgress: async (_attempts, observations) => {
        stage = 'report_write';
        const evaluation = evaluateGroundedAiQualificationV1(observations, reviewEvidence);
        await writePrivateReport(handle, reportInput(evaluation, new Date().toISOString(), 'in_progress'));
        stage = 'provider_evaluation';
      },
    });
    const evaluation = evaluateGroundedAiQualificationV1(run.observations, reviewEvidence);
    stage = 'report_write';
    const status = run.stopped || evaluation.notAttemptedCount > 0 ? 'inconclusive' : 'completed_pending_semantic_review';
    await writePrivateReport(handle, reportInput(evaluation, new Date().toISOString(), status));
    await handle.close();
    const reportSha256 = await sha256File(reportPath);
    stdout.write(`${JSON.stringify({ status,
      decision: evaluation.decision, decisionQualityStatus: 'NOT_QUALIFIED', requestCount: evaluation.requestCount,
      completedCount: evaluation.completedCount, failedCount: evaluation.failedCount, notAttemptedCount: evaluation.notAttemptedCount,
      reportPath: groundedAiQualificationV1ReportRelativePath, reportFileSha256: reportSha256 })}\n`);
    process.exitCode = evaluation.decision === 'FAIL' ? 1 : 2;
  } catch {
    try { await handle.close(); } catch { /* retain the initial or last complete private report */ }
    throw new Error('qualification_run_failed');
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => { console.error(sanitizedFailure(stage)); process.exitCode = 1; });
}

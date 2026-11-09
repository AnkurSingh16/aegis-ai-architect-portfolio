import { execFileSync } from 'node:child_process';
import { get } from 'node:http';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { analysisOutputJsonSchema, parseAnalysisOutput } from '../analysis.js';
import { createOllamaProvider, resolveOllamaConfig } from '../provider.js';
import { evaluationDatasetVersion, evaluationLabelStatus, plannedEvaluationSlotCount, plannedEvaluationSlots } from './dataset.js';
import { reservePrivateReport, writePrivateReport } from './private-report.js';
import { runPlannedEvaluation, type AttemptRecord } from './runner.js';

const expectedModel = 'qwen2.5:3b-instruct';
const expectedAttemptLimit = 6;
const evaluationPromptVersion = 'analysis-contract-v3b5-schema-v3b10';
const expectedBaseCommit = '62537cb902ef618ad5abce9ec6a22d6a71b59a09';
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../../');
const reportPath = resolve(repositoryRoot, '.local/evaluations/milestone-3b16-qwen2.5-3b-instruct.json');
const ollamaOrigin = 'http://127.0.0.1:11434';
const evidenceFields = ['synthetic_case_id', 'status', 'created_at', 'updated_at'];

interface LocalReport {
  status: 'in_progress' | 'completed' | 'stopped';
  datasetVersion: string;
  promptVersion: string;
  model: string;
  codeCommit: string;
  evaluationTimestamp: string;
  testMode: 'local-provider-evaluation-not-authenticated-http-e2e';
  labelStatus: string;
  plannedAttemptCount: number;
  attempts: AttemptRecord[];
  score?: Awaited<ReturnType<typeof runPlannedEvaluation>>['score'];
  stopReason?: string;
  limitations: string[];
}

function commandOutput(command: string, args: string[]): string {
  return execFileSync(command, args, { cwd: repositoryRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
}

function assertSourceIdentity(): string {
  const branch = commandOutput('git', ['branch', '--show-current']);
  const dirty = commandOutput('git', ['status', '--porcelain=v1']);
  if (branch !== 'feat/ai-evaluation-reliability' || dirty !== '') throw new Error('Evaluation source must be a clean approved feature branch.');
  commandOutput('git', ['merge-base', '--is-ancestor', expectedBaseCommit, 'HEAD']);
  commandOutput('git', ['diff', '--quiet', expectedBaseCommit, '--', 'apps/api/src/ai/analysis.ts', 'apps/api/src/ai/provider.ts',
    'apps/api/src/auth/routes.ts', 'apps/api/src/auth/transaction.ts', 'apps/api/src/auth/memberships.ts',
    'apps/api/src/storage/database.ts']);
  return commandOutput('git', ['rev-parse', 'HEAD']);
}

function assertLsofAvailableAndIdle(): void {
  const output = commandOutput('/usr/sbin/lsof', ['-nP', '-Fpcn', '-iTCP:11434']);
  const records: Array<{ pid: number; command: string; name: string }> = [];
  let pid = 0;
  let command = '';
  for (const line of output.split('\n')) {
    if (line.startsWith('p')) pid = Number(line.slice(1));
    else if (line.startsWith('c')) command = line.slice(1);
    else if (line.startsWith('n')) records.push({ pid, command, name: line.slice(1) });
  }
  const listeners = records.filter((item) => item.name.endsWith('(LISTEN)'));
  if (!listeners.some((item) => /^127\.0\.0\.1:11434 \(LISTEN\)$/.test(item.name)) ||
      listeners.some((item) => !/^127\.0\.0\.1:11434 \(LISTEN\)$/.test(item.name))) {
    throw new Error('Ollama is not bound exclusively to the approved loopback endpoint.');
  }
  const established = records.filter((item) => item.name.endsWith('(ESTABLISHED)'));
  const ownClientEndpoints = new Set(established.filter((item) => item.pid === process.pid &&
    /->127\.0\.0\.1:11434 \(ESTABLISHED\)$/.test(item.name)).map((item) => item.name.replace(/ \(ESTABLISHED\)$/, '')));
  for (const item of established) {
    const name = item.name.replace(/ \(ESTABLISHED\)$/, '');
    const isOllamaServerSide = /^127\.0\.0\.1:11434->127\.0\.0\.1:\d+$/.test(name);
    const isClientSide = /->127\.0\.0\.1:11434$/.test(name);
    if (isClientSide && item.pid !== process.pid) throw new Error('Another Ollama client is connected; concurrent generation cannot be ruled out.');
    if (isOllamaServerSide) {
      const remotePort = name.match(/->127\.0\.0\.1:(\d+)$/)?.[1];
      const matchingOwn = remotePort !== undefined && ownClientEndpoints.has(`127.0.0.1:${remotePort}->127.0.0.1:11434`);
      if (!matchingOwn || item.command !== 'ollama') throw new Error('Another Ollama client is connected; concurrent generation cannot be ruled out.');
    }
  }
}

async function getLocalJson(path: '/api/tags' | '/api/ps'): Promise<unknown> {
  return await new Promise((resolveResponse, reject) => {
    const request = get(`${ollamaOrigin}${path}`, { agent: false, headers: { connection: 'close' } }, (response) => {
      const chunks: Buffer[] = [];
      let length = 0;
      response.on('data', (chunk: Buffer) => {
        length += chunk.byteLength;
        if (length > 32 * 1024) {
          request.destroy();
          reject(new Error('Local Ollama health response exceeded the bound.'));
          return;
        }
        chunks.push(chunk);
      });
      response.on('end', () => {
        if (response.statusCode !== 200) {
          reject(new Error('Local Ollama health check failed.'));
          return;
        }
        try { resolveResponse(JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown); }
        catch { reject(new Error('Local Ollama health response was invalid.')); }
      });
    });
    request.setTimeout(3000, () => request.destroy(new Error('Local Ollama health check timed out.')));
    request.on('error', () => reject(new Error('Local Ollama health check failed.')));
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function assertOllamaReady(): Promise<void> {
  assertLsofAvailableAndIdle();
  const tags = await getLocalJson('/api/tags');
  const ps = await getLocalJson('/api/ps');
  if (!isRecord(tags) || !Array.isArray(tags.models) || tags.models.length !== 1 ||
      !isRecord(tags.models[0]) || tags.models[0].name !== expectedModel ||
      !isRecord(ps) || !Array.isArray(ps.models)) throw new Error('Approved local model or Ollama status did not match the evaluation preflight.');
  assertLsofAvailableAndIdle();
}

function assertEvaluationContract(): void {
  if (process.env.NODE_ENV !== 'development') throw new Error('Evaluation requires NODE_ENV=development.');
  const config = resolveOllamaConfig(process.env);
  if (!config || config.model !== expectedModel || config.timeoutMs !== 15000 || config.maxConcurrent !== 1) {
    throw new Error('Evaluation provider configuration does not match the approved local limits.');
  }
  if (plannedEvaluationSlotCount !== expectedAttemptLimit || plannedEvaluationSlots.length !== expectedAttemptLimit ||
      new Set(plannedEvaluationSlots.map((slot) => slot.id)).size !== expectedAttemptLimit ||
      plannedEvaluationSlots.some((slot) => !slot.caseType.startsWith('SYNTHETIC-'))) {
    throw new Error('Evaluation slots are not the fixed synthetic six-slot plan.');
  }
  const expectedProperties = ['category', 'priority', 'recommendedTeam', 'rationale', 'nextAction', 'confidence',
    'uncertainty', 'evidenceReferences', 'humanReviewRequired'];
  if (analysisOutputJsonSchema.required.join(',') !== expectedProperties.join(',') ||
      analysisOutputJsonSchema.properties.evidenceReferences.items.enum.join(',') !== evidenceFields.join(',')) {
    throw new Error('The reviewed output schema is unavailable.');
  }
  // A deterministic contract check; it makes no provider request.
  if (typeof parseAnalysisOutput !== 'function') throw new Error('Strict server-side output validation is unavailable.');
}

function sanitizeRunRecord(run: Awaited<ReturnType<typeof runPlannedEvaluation>>): LocalReport['attempts'] {
  return run.attempts.map((attempt) => ({
    attemptId: attempt.attemptId,
    slotId: attempt.slotId,
    caseType: attempt.caseType,
    kind: attempt.kind,
    expected: attempt.expected,
    status: attempt.status,
    ...(attempt.result === undefined ? {} : { result: attempt.result }),
    ...(attempt.failureStage === undefined ? {} : { failureStage: attempt.failureStage }),
    ...(attempt.schemaReason === undefined ? {} : { schemaReason: attempt.schemaReason }),
    ...(attempt.evidenceReason === undefined ? {} : { evidenceReason: attempt.evidenceReason }),
    ...(attempt.latencyMs === undefined ? {} : { latencyMs: attempt.latencyMs }),
    ...(attempt.responseBytes === undefined ? {} : { responseBytes: attempt.responseBytes }),
    ...(attempt.httpStatus === undefined ? {} : { httpStatus: attempt.httpStatus }),
    ...(attempt.promptTokens === undefined ? {} : { promptTokens: attempt.promptTokens }),
    ...(attempt.generatedTokens === undefined ? {} : { generatedTokens: attempt.generatedTokens }),
    correlationComplete: attempt.correlationComplete,
  }));
}

async function readAuthorization(): Promise<boolean> {
  if (!stdin.isTTY || !stdout.isTTY) throw new Error('A normal interactive terminal is required for local evaluation.');
  const prompt = createInterface({ input: stdin, output: stdout });
  try { return await prompt.question('This runs at most six local synthetic evaluations. Type RUN SIX LOCAL EVALUATIONS to continue: ') === 'RUN SIX LOCAL EVALUATIONS'; }
  finally { prompt.close(); }
}

async function main(): Promise<void> {
  if (process.argv.length !== 2) throw new Error('The local evaluation command accepts no arguments.');
  const codeCommit = assertSourceIdentity();
  assertEvaluationContract();
  await assertOllamaReady();
  const config = resolveOllamaConfig(process.env);
  if (!config) throw new Error('Local model provider is disabled.');
  const authorized = await readAuthorization();
  if (!authorized) {
    stdout.write('Evaluation cancelled before any model request.\n');
    return;
  }

  const handle = await reservePrivateReport(reportPath);
  const started = new Date().toISOString();
  const base: LocalReport = {
    status: 'in_progress', datasetVersion: evaluationDatasetVersion, model: expectedModel, codeCommit,
    promptVersion: evaluationPromptVersion,
    evaluationTimestamp: started, testMode: 'local-provider-evaluation-not-authenticated-http-e2e',
    labelStatus: evaluationLabelStatus, plannedAttemptCount: expectedAttemptLimit, attempts: [],
    limitations: [
      'Three synthetic case types and six paired observations are a smoke evaluation, not statistically reliable model-quality evidence.',
      'Timestamp-paired observations are not independent cases; self-constructed labels are engineering-reviewed, not human-approved.',
      'Model-reported confidence is uncalibrated; case-field references are not RAG citations or external grounding.',
      'Provider-level calls do not measure Auth0 authorization, PostgreSQL RLS, or end-to-end HTTP correlation.',
      'No raw prompts, rationales, provider response bodies, credentials, or rejected model output are stored.',
    ],
  };
  try {
    await writePrivateReport(handle, base);
    const run = await runPlannedEvaluation(plannedEvaluationSlots, (log) => createOllamaProvider(config, { log }),
      async () => {
        try { await assertOllamaReady(); return true; }
        catch { return false; }
      }, async (attempts) => {
        await writePrivateReport(handle, { ...base, attempts: [...attempts] as AttemptRecord[] });
      });
    const final: LocalReport = {
      ...base, status: run.stoppedEarly ? 'stopped' : 'completed',
      attempts: sanitizeRunRecord(run), score: run.score, stopReason: run.stopReason,
    };
    await writePrivateReport(handle, final);
    stdout.write(`${JSON.stringify({ status: final.status, model: final.model, codeCommit: final.codeCommit,
      plannedSlots: expectedAttemptLimit, attempted: run.score.attempted, succeeded: run.score.succeeded,
      failed: run.score.failed, notAttempted: run.score.notAttempted, reportPath: '.local/evaluations/milestone-3b16-qwen2.5-3b-instruct.json' })}\n`);
    if (final.status !== 'completed') process.exitCode = 1;
  } finally { await handle.close(); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => {
    console.error('Local evaluation stopped safely. No retry was performed. Inspect only the sanitized report if it was created.');
    process.exitCode = 1;
  });
}

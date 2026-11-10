import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { get } from 'node:http';
import { stdin, stdout } from 'node:process';
import { createInterface } from 'node:readline/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { syntheticDocuments } from '../../documents/catalog.js';
import { syntheticCases } from '../../contracts/triage.js';
import { groundedAnalysisSchema, parseGroundedProviderOutput, type GroundedSource } from '../grounded-analysis.js';
import { createGroundedOllamaProvider } from '../grounded-provider.js';
import { resolveOllamaConfig } from '../provider.js';
import { groundedEvaluationSlots, scoreGroundedEvaluation } from './grounded-scoring.js';
import { runGroundedProviderEvaluation } from './grounded-runner.js';
import { verifyGroundedEvaluationSource } from './source-identity.js';
import { reservePrivateReport, writePrivateReport } from './private-report.js';
import { assertSafeOllamaTcpRecords, parseOllamaTcpRecords } from './ollama-socket-preflight.js';

const expectedModel = 'qwen2.5:3b-instruct';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../../');
const reportPath = resolve(root, '.local/evaluations/milestone-4-grounded-qwen2.5-3b-instruct.json');
const localOrigin = 'http://127.0.0.1:11434';

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
function inMemorySources(caseType: string): GroundedSource[] {
  const identity = groundedEvaluationSlots.find((item) => item.caseType === caseType)?.expectedSourceIdentity;
  const document = syntheticDocuments.find((item) => item.sourceIdentity === identity);
  if (!document) throw new Error('Grounded evaluation source mapping is invalid.');
  return [{ citationId: randomUUID(), title: document.title, sourceIdentity: document.sourceIdentity, version: document.version,
    position: 0, content: document.content }];
}

async function main(): Promise<void> {
  if (process.argv.length !== 2) throw new Error('Grounded evaluation accepts no command-line arguments.');
  const source = verifyGroundedEvaluationSource((args) => execFileSync('git', [...args],
    { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim());
  if (process.env.NODE_ENV !== 'development' || process.env.AEGIS_AI_ENABLED !== 'true' || process.env.AEGIS_GROUNDED_AI_ENABLED !== 'true') {
    throw new Error('Grounded evaluation requires explicit local development opt-in.');
  }
  const config = resolveOllamaConfig(process.env);
  if (!config || config.model !== expectedModel || config.timeoutMs !== 15000 || config.maxConcurrent !== 1 ||
      groundedEvaluationSlots.length !== 6 || new Set(groundedEvaluationSlots.map((slot) => slot.slotId)).size !== 6 ||
      groundedAnalysisSchema.properties.humanReviewRequired.enum[0] !== true || typeof parseGroundedProviderOutput !== 'function') {
    throw new Error('Grounded evaluation contract or approved limits are unavailable.');
  }
  for (const item of syntheticCases) if (!groundedEvaluationSlots.some((slot) => slot.caseType === item.id)) throw new Error('Grounded evaluation case plan is incomplete.');
  await assertModelReady();
  if (!await confirmRun()) { stdout.write('Grounded evaluation cancelled before any model request.\n'); return; }

  const handle = await reservePrivateReport(reportPath);
  const timestamp = new Date().toISOString();
  const base = { datasetVersion: 'aegis-grounded-provider-v1', ...source, model: expectedModel, evaluationTimestamp: timestamp,
    testMode: 'provider-level-in-memory-synthetic-not-authenticated-http-e2e', plannedSlots: 6,
    labelStatus: 'engineering-reviewed-not-human-approved', status: 'in_progress' as const,
    limitations: ['Three synthetic case types with paired observations are a smoke test, not production accuracy evidence.',
      'Provider-level in-memory execution does not validate Auth0, membership, RLS, or HTTP request correlation.',
      'Citation identity and evidence coverage are deterministic checks, not proof that claims are semantically entailed.',
      'Groundedness review agreement is not measured until an independent reviewer supplies that assessment.',
      'No prompts, rationales, raw responses, credentials, or rejected model output are stored.'] };
  try {
    await writePrivateReport(handle, { ...base, attempts: [], score: scoreGroundedEvaluation([]) });
    const run = await runGroundedProviderEvaluation({
      providerFactory: (log) => createGroundedOllamaProvider(config, { log }),
      healthCheck: async () => { try { await assertModelReady(); return true; } catch { return false; } },
      sourcesFor: inMemorySources,
      onProgress: async (attempts, observations) => { await writePrivateReport(handle, { ...base, status: 'in_progress', attempts,
        score: scoreGroundedEvaluation(observations) }); },
    });
    const score = scoreGroundedEvaluation(run.observations);
    const status = run.stopped || score.notAttempted > 0 ? 'stopped' : 'completed';
    await writePrivateReport(handle, { ...base, status, attempts: run.attempts, score });
    stdout.write(`${JSON.stringify({ status, model: expectedModel, ...source, planned: 6, attempted: score.attempted,
      succeeded: score.succeeded, failed: score.failed, notAttempted: score.notAttempted, reportPath: '.local/evaluations/milestone-4-grounded-qwen2.5-3b-instruct.json' })}\n`);
    if (status !== 'completed') process.exitCode = 1;
  } finally { await handle.close(); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => { console.error('Grounded evaluation stopped safely. No retry was performed. Inspect only its sanitized private report if created.'); process.exitCode = 1; });
}

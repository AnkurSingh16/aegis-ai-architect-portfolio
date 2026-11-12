import Ajv from 'ajv';
import { execFileSync } from 'node:child_process';
import { get } from 'node:http';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stdin, stdout } from 'node:process';
import { createInterface } from 'node:readline/promises';
import { groundedAnalysisSchema } from '../grounded-analysis.js';
import { resolveOllamaConfig } from '../provider.js';
import { assertSafeOllamaTcpRecords, parseOllamaTcpRecords } from './ollama-socket-preflight.js';
import { groundedBalancedScenarios } from './grounded-balanced-dataset.js';
import { createSupportedOutputDiagnosticProvider, createSupportedOutputDiagnosticReport, createSupportedOnlySchema,
  supportedOutputDiagnosticConfig, supportedOutputDiagnosticReportPath, runSupportedOutputDiagnostic } from './grounded-supported-output-diagnostic.js';
import { reservePrivateReport, writePrivateReport } from './private-report.js';

const baseCommit = '976856cc9eea8b4195712a3c73b4e82730cef5e5';
const branch = 'feat/m4-grounded-supported-output-diagnostic';
const confirmation = 'RUN GROUNDED SUPPORTED OUTPUT DIAGNOSTIC V1';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../../');
const reportPath = resolve(root, supportedOutputDiagnosticReportPath);
const proxyNames = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy'];

export function assertNoDiagnosticProxy(env: NodeJS.ProcessEnv, execArgv: readonly string[] = []): void {
  const proxyFlag = (arg: string): boolean => arg === '--use-env-proxy' || arg.startsWith('--use-env-proxy=');
  const nodeOptions = (env.NODE_OPTIONS ?? '').split(/\s+/).filter(Boolean).some(proxyFlag);
  const nodeMode = ['1', 'true', 'yes'].includes((env.NODE_USE_ENV_PROXY ?? '').trim().toLowerCase());
  if (proxyNames.some((name) => Boolean(env[name]?.trim())) || nodeMode || nodeOptions || execArgv.some(proxyFlag)) {
    throw new Error('proxy_configuration_not_allowed');
  }
}

function git(args: readonly string[]): string {
  return execFileSync('git', [...args], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
}

export function verifySupportedOutputDiagnosticSource(readGit: (args: readonly string[]) => string) {
  if (readGit(['branch', '--show-current']) !== 'main' || readGit(['status', '--porcelain=v1']) !== '') {
    throw new Error('source_not_clean_merged_main');
  }
  const commit = readGit(['rev-parse', 'HEAD']);
  const tree = readGit(['rev-parse', 'HEAD^{tree}']);
  if (readGit(['rev-parse', 'origin/main']) !== commit || readGit(['rev-parse', 'origin/main^{tree}']) !== tree) {
    throw new Error('main_not_synchronized');
  }
  if (readGit(['rev-parse', `origin/${branch}^{tree}`]) !== tree) throw new Error('reviewed_tree_mismatch');
  readGit(['merge-base', '--is-ancestor', baseCommit, commit]);
  return { codeCommit: commit, treeHash: tree, sourceRef: 'origin/main', reviewedRefCommit: readGit(['rev-parse', `origin/${branch}`]) };
}

function assertNoOtherClient(): void {
  const raw = execFileSync('/usr/sbin/lsof', ['-nP', '-FpcnT', '-iTCP:11434'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  assertSafeOllamaTcpRecords(parseOllamaTcpRecords(raw), process.pid);
}

async function getLocalJson(path: '/api/tags' | '/api/ps'): Promise<unknown> {
  return await new Promise((resolveValue, reject) => {
    const request = get(`http://127.0.0.1:11434${path}`, { agent: false, headers: { connection: 'close' } }, (response) => {
      const parts: Buffer[] = [];
      let size = 0;
      response.on('data', (part: Buffer) => {
        size += part.byteLength;
        if (size > 32768) { request.destroy(); reject(new Error('health_bound')); return; }
        parts.push(part);
      });
      response.on('end', () => {
        if (response.statusCode !== 200) { reject(new Error('health_status')); return; }
        try { resolveValue(JSON.parse(Buffer.concat(parts, size).toString('utf8')) as unknown); }
        catch { reject(new Error('health_json')); }
      });
    });
    request.setTimeout(3000, () => request.destroy(new Error('health_timeout')));
    request.on('error', () => reject(new Error('health_request')));
  });
}

async function modelReady(): Promise<void> {
  assertNoOtherClient();
  const [tags, ps] = await Promise.all([getLocalJson('/api/tags'), getLocalJson('/api/ps')]);
  if (typeof tags !== 'object' || tags === null || !Array.isArray((tags as { models?: unknown }).models) ||
      !(tags as { models: Array<{ name?: unknown }> }).models.some((item) => item?.name === supportedOutputDiagnosticConfig.model) ||
      typeof ps !== 'object' || ps === null || !Array.isArray((ps as { models?: unknown }).models)) throw new Error('model_not_ready');
  assertNoOtherClient();
}

async function confirm(): Promise<boolean> {
  if (!stdin.isTTY || !stdout.isTTY) throw new Error('interactive_terminal_required');
  const rl = createInterface({ input: stdin, output: stdout });
  try { return await rl.question(`This diagnostic makes at most three local model requests. Type ${confirmation}: `) === confirmation; }
  finally { rl.close(); }
}

async function main(): Promise<void> {
  const source = verifySupportedOutputDiagnosticSource(git);
  if (process.argv.length !== 2 || process.env.NODE_ENV !== 'development' || process.env.AEGIS_AI_ENABLED !== 'true' ||
      process.env.AEGIS_GROUNDED_AI_ENABLED !== 'true' || process.env.AEGIS_OLLAMA_MODEL !== supportedOutputDiagnosticConfig.model) {
    throw new Error('explicit_local_opt_in_required');
  }
  assertNoDiagnosticProxy(process.env, process.execArgv);
  const config = resolveOllamaConfig(process.env);
  if (!config || config.model !== supportedOutputDiagnosticConfig.model || config.timeoutMs !== 15000 || config.maxConcurrent !== 1 ||
      groundedBalancedScenarios.length !== 6 || groundedAnalysisSchema.oneOf.length !== 2) throw new Error('runtime_contract_invalid');
  const schema = createSupportedOnlySchema();
  const ajvValidate = new Ajv({ allErrors: true, coerceTypes: false, removeAdditional: false }).compile(schema);
  const validate = (value: unknown): boolean => ajvValidate(value) === true;
  await modelReady();
  if (!await confirm()) return;
  const handle = await reservePrivateReport(reportPath);
  try {
    const outcomes = await runSupportedOutputDiagnostic({ provider: createSupportedOutputDiagnosticProvider(config,
      { beforeRequest: assertNoOtherClient }), validateSchema: validate });
    await writePrivateReport(handle, createSupportedOutputDiagnosticReport({ source, outcomes }));
    stdout.write(`${JSON.stringify({ evaluatorVersion: 'aegis-grounded-supported-output-diagnostic-v1', reportPath: supportedOutputDiagnosticReportPath,
      decisionQualityStatus: 'NOT_RATED', attempted: outcomes.length })}\n`);
  } finally { await handle.close(); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => { console.error('{"event":"grounded_supported_output_diagnostic_failed","failureStage":"preflight_or_run"}'); process.exitCode = 1; });
}

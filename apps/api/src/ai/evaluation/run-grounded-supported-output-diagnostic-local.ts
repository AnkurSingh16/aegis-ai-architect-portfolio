import Ajv from 'ajv';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
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

const approvedM422Commit = '3fe57fd8a366b4532a440222355de0a5b3821c1d';
const approvedM422Tree = '79d0a6a50a59880a16a0f2294475686ccfe89872';
const approvedM422FeatureRef = 'origin/feat/m4-grounded-supported-output-diagnostic';
const approvedM422FeatureHead = '536f702f8423824479bd77145c7031856ec5a069';
const approvedM423Commit = '59cb95f32389ae1ed2fd6715f1e0e983bffb6b0c';
const approvedM423Tree = '7dfb48eaa27f7ae0b3cdb36f66d143655af46d84';
const approvedM423FeatureRef = 'origin/fix/m423-ollama-closed-socket-preflight';
const approvedM423FeatureHead = 'a543dab169265754bfe38252abd47c6d98fc3d63';
// Keep this reviewed branch available after squash merge as the source-gate blob anchor.
const sourceIdentityFeatureRef = 'origin/fix/m4.22-source-identity-gate';
const reviewedM422Blobs = {
  'apps/api/src/ai/evaluation/grounded-supported-output-diagnostic.ts': '7bce941f7f59e5d9b1bd1f9c66ed1bb2a27e8b36',
  'apps/api/src/ai/grounded-analysis.ts': 'e39dff2024fc1ca593d54a4e96f0a8644ef64c02',
  'apps/api/src/ai/evaluation/grounded-balanced-dataset.ts': 'a4c3ed5dd2f35d2628dc5319a402da873db96217',
  'apps/api/src/ai/grounded-provider.ts': 'e2a7b76d059f0c2538f1b095e54df08eea99a4e4',
  'apps/api/src/ai/provider.ts': 'dc8dc7be163ee454771fdc188632ea396d4c022d',
  'apps/api/src/ai/evaluation/private-report.ts': '2514348183e39e5411a2ddfb0b90a4394140068c',
} as const;
const runnerPath = 'apps/api/src/ai/evaluation/run-grounded-supported-output-diagnostic-local.ts';
const socketGuardPath = 'apps/api/src/ai/evaluation/ollama-socket-preflight.ts';
const reviewedM423SocketGuardBlob = 'c7c37967915bfcccd47c21150ca7ca0996667767';
const allowedPostM423Paths = [runnerPath, 'apps/api/src/ai/evaluation/grounded-supported-output-diagnostic.test.ts'];
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
  const requireRef = (ref: string, expected: string): void => {
    let actual: string;
    try { actual = readGit(['rev-parse', ref]); }
    catch { throw new Error('approved_source_ref_missing'); }
    if (actual !== expected) throw new Error('approved_source_ref_mismatch');
  };
  const requireBlob = (ref: string, path: string, expected: string): void => {
    let actual: string;
    try { actual = readGit(['rev-parse', `${ref}:${path}`]); }
    catch { throw new Error('approved_source_blob_missing'); }
    if (actual !== expected) throw new Error('reviewed_source_blob_mismatch');
  };
  const requireAncestor = (ancestor: string): void => {
    try { readGit(['merge-base', '--is-ancestor', ancestor, commit]); }
    catch { throw new Error('approved_release_not_ancestor'); }
  };

  requireRef(`${approvedM422Commit}^{tree}`, approvedM422Tree);
  requireRef(`${approvedM423Commit}^{tree}`, approvedM423Tree);
  requireRef(`${approvedM422FeatureRef}`, approvedM422FeatureHead);
  requireRef(`${approvedM422FeatureRef}^{tree}`, approvedM422Tree);
  requireRef(`${approvedM423FeatureRef}`, approvedM423FeatureHead);
  requireRef(`${approvedM423FeatureRef}^{tree}`, approvedM423Tree);
  const reviewedRunnerCommit = (() => {
    try { return readGit(['rev-parse', sourceIdentityFeatureRef]); }
    catch { throw new Error('approved_source_ref_missing'); }
  })();
  let liveRefs: Map<string, string>;
  try {
    liveRefs = new Map(readGit(['ls-remote', 'origin', 'refs/heads/main',
      'refs/heads/feat/m4-grounded-supported-output-diagnostic',
      'refs/heads/fix/m423-ollama-closed-socket-preflight', 'refs/heads/fix/m4.22-source-identity-gate'])
      .split('\n').filter(Boolean).map((line) => {
        const [oid, ref] = line.split('\t');
        if (!oid || !ref) throw new Error('remote_ref_shape');
        return [ref, oid];
      }));
  } catch { throw new Error('live_source_refs_unavailable'); }
  const expectedLiveRefs = new Map([
    ['refs/heads/main', commit],
    ['refs/heads/feat/m4-grounded-supported-output-diagnostic', approvedM422FeatureHead],
    ['refs/heads/fix/m423-ollama-closed-socket-preflight', approvedM423FeatureHead],
    ['refs/heads/fix/m4.22-source-identity-gate', reviewedRunnerCommit],
  ]);
  if ([...expectedLiveRefs].some(([ref, expected]) => liveRefs.get(ref) !== expected)) {
    throw new Error('live_source_refs_mismatch');
  }
  requireAncestor(approvedM422Commit);
  requireAncestor(approvedM423Commit);

  let changedPaths: string[];
  try { changedPaths = readGit(['diff', '--name-only', `${approvedM423Commit}..HEAD`]).split('\n').filter(Boolean).sort(); }
  catch { throw new Error('approved_release_diff_unavailable'); }
  if (changedPaths.some((path) => !allowedPostM423Paths.includes(path)) ||
      !allowedPostM423Paths.every((path) => changedPaths.includes(path))) {
    throw new Error('unreviewed_post_release_changes');
  }

  for (const [path, blob] of Object.entries(reviewedM422Blobs)) {
    requireBlob(approvedM422Commit, path, blob);
    requireBlob(approvedM422FeatureRef, path, blob);
    requireBlob('HEAD', path, blob);
  }
  let approvedRunnerBlob: string;
  let reviewedRunnerBlob: string;
  try {
    approvedRunnerBlob = readGit(['rev-parse', `${approvedM422Commit}:${runnerPath}`]);
    reviewedRunnerBlob = readGit(['rev-parse', `${approvedM422FeatureRef}:${runnerPath}`]);
  } catch { throw new Error('approved_source_blob_missing'); }
  if (!/^[0-9a-f]{40}$/.test(approvedRunnerBlob) || approvedRunnerBlob !== reviewedRunnerBlob) {
    throw new Error('reviewed_source_blob_mismatch');
  }
  requireBlob('HEAD', socketGuardPath, reviewedM423SocketGuardBlob);
  requireBlob(approvedM423Commit, socketGuardPath, reviewedM423SocketGuardBlob);
  requireBlob(approvedM423FeatureRef, socketGuardPath, reviewedM423SocketGuardBlob);

  let originalRunner: string;
  let currentRunner: string;
  try {
    originalRunner = readGit(['show', `${approvedM422Commit}:${runnerPath}`]);
    currentRunner = readGit(['show', `HEAD:${runnerPath}`]);
  } catch { throw new Error('reviewed_runner_source_missing'); }
  const normalizeReviewedRunner = (source: string): string => {
    const identityImport = "import { createHash } from 'node:crypto';\n";
    if (source.split(identityImport).length > 2) throw new Error('reviewed_runner_source_shape_invalid');
    let normalized = source.replace(identityImport, '');
    const sourceGateStart = normalized.indexOf("const approvedM422Commit = '");
    const confirmationStart = normalized.indexOf("const confirmation = '", sourceGateStart);
    if (sourceGateStart >= 0) {
      if (confirmationStart < 0) throw new Error('reviewed_runner_source_shape_invalid');
      const expectedIdentityDeclarations = [
        `const approvedM422Commit = '${approvedM422Commit}';`,
        `const approvedM422Tree = '${approvedM422Tree}';`,
        `const approvedM422FeatureRef = '${approvedM422FeatureRef}';`,
        `const approvedM422FeatureHead = '${approvedM422FeatureHead}';`,
        `const approvedM423Commit = '${approvedM423Commit}';`,
        `const approvedM423Tree = '${approvedM423Tree}';`,
        `const approvedM423FeatureRef = '${approvedM423FeatureRef}';`,
        `const approvedM423FeatureHead = '${approvedM423FeatureHead}';`,
        '// Keep this reviewed branch available after squash merge as the source-gate blob anchor.',
        `const sourceIdentityFeatureRef = '${sourceIdentityFeatureRef}';`,
        `const reviewedM422Blobs = {\n${Object.entries(reviewedM422Blobs).map(([path, blob]) => `  '${path}': '${blob}',`).join('\n')}\n} as const;`,
        `const runnerPath = '${runnerPath}';`,
        `const socketGuardPath = '${socketGuardPath}';`,
        `const reviewedM423SocketGuardBlob = '${reviewedM423SocketGuardBlob}';`,
        "const allowedPostM423Paths = [runnerPath, 'apps/api/src/ai/evaluation/grounded-supported-output-diagnostic.test.ts'];",
      ].join('\n');
      if (normalized.slice(sourceGateStart, confirmationStart).trimEnd() !== expectedIdentityDeclarations) {
        throw new Error('reviewed_runner_source_shape_invalid');
      }
      normalized = `${normalized.slice(0, sourceGateStart)}const baseCommit = '976856cc9eea8b4195712a3c73b4e82730cef5e5';\nconst branch = 'feat/m4-grounded-supported-output-diagnostic';\n${normalized.slice(confirmationStart)}`;
    }
    const start = normalized.indexOf('export function verifySupportedOutputDiagnosticSource(');
    const end = normalized.indexOf('\nfunction assertNoOtherClient()', start);
    if (start < 0 || end < 0) throw new Error('reviewed_runner_source_shape_invalid');
    return `${normalized.slice(0, start)}/* reviewed source gate */${normalized.slice(end)}`;
  };
  const gitBlobId = (source: string): string => {
    const bytes = Buffer.from(source, 'utf8');
    return createHash('sha1').update(`blob ${bytes.byteLength}\0`).update(bytes).digest('hex');
  };
  if (gitBlobId(normalizeReviewedRunner(originalRunner)) !== gitBlobId(normalizeReviewedRunner(currentRunner))) {
    throw new Error('unreviewed_runner_changes');
  }
  let currentRunnerBlob: string;
  try { currentRunnerBlob = readGit(['rev-parse', `HEAD:${runnerPath}`]); }
  catch { throw new Error('approved_source_blob_missing'); }
  requireBlob(sourceIdentityFeatureRef, runnerPath, currentRunnerBlob);

  return { codeCommit: commit, treeHash: tree, sourceRef: 'origin/main', reviewedRefCommit: reviewedRunnerCommit };
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

#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { chmod, lstat, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseEnv } from 'node:util';
import { verifyHcpConfiguration } from './hcp-preflight.mjs';

export const organizationName = 'aegis-ai-portfolio';
export const workspaceName = 'aegis-auth0-dev';
export const targetAddress = 'auth0_client.local_spa';
export const expectedResourceAddresses = Object.freeze([
  'auth0_resource_server.cases',
  'auth0_resource_server_scope.read_cases',
  'auth0_resource_server_scope.write_cases',
  targetAddress,
  'auth0_connection_client.local_spa_database',
]);
export const approvedBrowserOrigin = 'http://127.0.0.1:5173';
const callbackBefore = ['http://127.0.0.1:49321/auth/callback'];
const callbackAfter = [...callbackBefore, `${approvedBrowserOrigin}/`];
const originBefore = ['http://127.0.0.1:49321'];
const originAfter = [...originBefore, approvedBrowserOrigin];
const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(moduleDirectory, '../../..');
const metadataDirectory = path.join(moduleDirectory, '.terraform');
const secretFile = path.join(repositoryRoot, '.env.auth0');
const runtimeConfigFile = path.join(repositoryRoot, '.env.api');
const variablesFile = path.join(moduleDirectory, 'terraform.tfvars');
const artifactPrefix = '.aegis-browser-origin-update-';
const approvalLifetimeMs = 5 * 60 * 1000;

function record(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (record(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
function same(left, right) { return canonical(left) === canonical(right); }
function containsTrue(value) {
  if (value === true) return true;
  if (Array.isArray(value)) return value.some(containsTrue);
  if (record(value)) return Object.values(value).some(containsTrue);
  return false;
}

/** Validate that Terraform proposes only the approved three URL additions. */
export function validateBrowserOriginUpdatePlan(document, { spaName, spaClientId } = {}) {
  if (typeof spaName !== 'string' || !spaName || typeof spaClientId !== 'string' || !spaClientId) {
    throw new Error('The expected local SPA identity is unavailable. Stop for manual review.');
  }
  const format = typeof document?.format_version === 'string' ? /^1\.\d+$/.test(document.format_version) : false;
  if (!record(document) || !format || typeof document.terraform_version !== 'string' ||
      document.errored !== false || document.complete !== true || document.applyable !== true ||
      !Array.isArray(document.resource_changes) ||
      (document.resource_drift !== undefined && (!Array.isArray(document.resource_drift) || document.resource_drift.length !== 0)) ||
      (document.deferred_changes !== undefined && (!Array.isArray(document.deferred_changes) || document.deferred_changes.length !== 0)) ||
      (document.action_invocations !== undefined && (!Array.isArray(document.action_invocations) || document.action_invocations.length !== 0)) ||
      (document.output_changes !== undefined && (!record(document.output_changes) || Object.keys(document.output_changes).length !== 0))) {
    throw new Error('Terraform plan is malformed, incomplete, or contains drift or unrelated changes. Stop for manual review.');
  }
  if (record(document.planned_values) && document.planned_values.root_module?.child_modules?.length) {
    throw new Error('Terraform plan contains an unexpected module.');
  }
  if (document.configuration?.root_module?.module_calls && Object.keys(document.configuration.root_module.module_calls).length !== 0) {
    throw new Error('Terraform plan contains an unexpected module configuration.');
  }

  const changes = new Map();
  for (const item of document.resource_changes) {
    if (!record(item) || item.mode !== 'managed' || item.module_address !== undefined || item.index !== undefined ||
        item.previous_address !== undefined || item.deposed !== undefined || item.generated_config !== undefined ||
        item.address !== `${item.type}.${item.name}` || item.provider_name !== 'registry.terraform.io/auth0/auth0' ||
        !record(item.change) || !Array.isArray(item.change.actions) || !record(item.change.after_unknown) ||
        containsTrue(item.change.after_unknown) || item.change.importing !== undefined ||
        (item.change.replace_paths !== undefined && (!Array.isArray(item.change.replace_paths) || item.change.replace_paths.length !== 0)) ||
        (item.action_reason !== undefined && typeof item.action_reason !== 'string')) {
      throw new Error('Terraform plan contains an unsupported resource action or unknown value.');
    }
    if (changes.has(item.address)) throw new Error('Terraform plan contains duplicate resource addresses.');
    changes.set(item.address, item);
  }
  if (changes.size !== expectedResourceAddresses.length || expectedResourceAddresses.some((address) => !changes.has(address))) {
    throw new Error('Terraform plan inventory does not exactly match the five approved Aegis resources.');
  }

  for (const address of expectedResourceAddresses) {
    const change = changes.get(address).change;
    if (address === targetAddress) continue;
    if (!same(change.actions, ['no-op']) || !record(change.before) || !record(change.after) || !same(change.before, change.after)) {
      throw new Error(`Terraform planned an unexpected change to ${address}.`);
    }
  }

  const target = changes.get(targetAddress).change;
  if (!same(target.actions, ['update']) || !record(target.before) || !record(target.after)) {
    throw new Error('Terraform plan must contain exactly one in-place SPA update.');
  }
  if (target.before.id !== spaClientId || target.after.id !== spaClientId || target.before.name !== spaName ||
      target.after.name !== spaName || target.before.app_type !== 'spa' || target.after.app_type !== 'spa') {
    throw new Error('Terraform plan does not target the configured Auth0 SPA identity.');
  }
  for (const key of ['callbacks', 'web_origins', 'allowed_logout_urls']) {
    if (!same(target.before[key], key === 'callbacks' ? callbackBefore : originBefore) ||
        !same(target.after[key], key === 'callbacks' ? callbackAfter : originAfter)) {
      throw new Error(`Terraform planned an unexpected ${key} value or removed the smoke-test URL.`);
    }
  }
  if (!same(target.before.allowed_origins, originBefore) || !same(target.after.allowed_origins, originBefore)) {
    throw new Error('Terraform planned an unexpected CORS origin change.');
  }
  const beforeUnchanged = { ...target.before };
  const afterUnchanged = { ...target.after };
  for (const key of ['callbacks', 'web_origins', 'allowed_logout_urls']) {
    delete beforeUnchanged[key];
    delete afterUnchanged[key];
  }
  if (!same(beforeUnchanged, afterUnchanged)) {
    throw new Error('Terraform planned an unexpected change to another SPA attribute.');
  }
  return Object.freeze({
    creates: 0, updates: 1, deletes: 0, addresses: expectedResourceAddresses,
    before: Object.freeze({ callbacks: callbackBefore, web_origins: originBefore, allowed_logout_urls: originBefore }),
    after: Object.freeze({ callbacks: callbackAfter, web_origins: originAfter, allowed_logout_urls: originAfter }),
  });
}

export function isAutomatedContext(env = process.env) {
  return Boolean(env.CI || env.GITHUB_ACTIONS || env.NODE_ENV === 'test' || env.VITEST || env.JEST_WORKER_ID ||
    Object.keys(env).some((key) => key.startsWith('CODEX_') || key.startsWith('OPENAI_CODEX')));
}

export function assertInteractiveInvocation({ argv = process.argv, stdinIsTTY = stdin.isTTY,
  stdoutIsTTY = stdout.isTTY, env = process.env } = {}) {
  if (argv.length !== 2 || !stdinIsTTY || !stdoutIsTTY || isAutomatedContext(env)) {
    throw new Error('This update gate requires a direct, interactive operator terminal and accepts no arguments.');
  }
}

function parseQuotedTfvars(content, key) {
  const matches = [...content.matchAll(new RegExp(`^\\s*${key}\\s*=\\s*"([^"\\r\\n]+)"\\s*$`, 'gm'))];
  if (matches.length !== 1) throw new Error('Terraform inputs are missing or ambiguous.');
  return matches[0][1];
}

export function parseSpaName(content) {
  const lines = content.split(/\r?\n/).filter((line) => /^\s*spa_name\s*=/.test(line));
  if (lines.length === 0) return 'Aegis AI Local SPA';
  if (lines.length !== 1) throw new Error('Terraform inputs contain duplicate SPA names.');
  const match = /^\s*spa_name\s*=\s*"([^"\r\n]+)"\s*(?:#.*)?$/.exec(lines[0]);
  if (!match) throw new Error('Terraform SPA name input is malformed.');
  return match[1];
}

async function loadLocalConfiguration({ readFileImpl = readFile, statImpl = lstat }) {
  const [secretStat, runtimeStat, variableStat] = await Promise.all([
    statImpl(secretFile), statImpl(runtimeConfigFile), statImpl(variablesFile),
  ]);
  if ([secretStat, runtimeStat, variableStat].some((file) => (file.mode & 0o077) !== 0 || !file.isFile() || file.isSymbolicLink())) {
    throw new Error('Local Auth0 credentials, runtime identity and Terraform inputs must be regular files with mode 0600.');
  }
  const [secrets, runtimeConfig] = await Promise.all([
    readFileImpl(secretFile, 'utf8').then(parseEnv), readFileImpl(runtimeConfigFile, 'utf8').then(parseEnv),
  ]);
  const varsText = await readFileImpl(variablesFile, 'utf8');
  const auth0Domain = secrets.AUTH0_DOMAIN;
  const runtimeIssuer = runtimeConfig.AUTH0_ISSUER;
  const spaClientId = runtimeConfig.AUTH0_SPA_CLIENT_ID;
  if (typeof auth0Domain !== 'string' || !/^[A-Za-z0-9.-]+\.auth0\.com$/.test(auth0Domain) ||
      !secrets.AUTH0_CLIENT_ID || !secrets.AUTH0_CLIENT_SECRET ||
      typeof spaClientId !== 'string' || spaClientId.length === 0 ||
      runtimeIssuer !== `https://${auth0Domain}/` ||
      parseQuotedTfvars(varsText, 'auth0_domain') !== auth0Domain ||
      !parseQuotedTfvars(varsText, 'database_connection_id')) {
    throw new Error('Local Auth0 configuration does not match the reviewed development tenant inputs.');
  }
  const spaName = parseSpaName(varsText);
  return Object.freeze({ auth0Domain, auth0ClientId: secrets.AUTH0_CLIENT_ID,
    auth0ClientSecret: secrets.AUTH0_CLIENT_SECRET, spaName, spaClientId });
}

function sameStateIdentity(actual) {
  const expected = ['organization', 'plan', 'workspace', 'workspaceId', 'executionMode', 'autoApply', 'state',
    'backendFingerprint', 'stateVersionId', 'serial', 'inventoryHash'];
  return record(actual) && expected.every((key) => Object.hasOwn(actual, key)) &&
    actual.organization === organizationName && actual.plan === 'free' && actual.workspace === workspaceName &&
    typeof actual.workspaceId === 'string' && actual.workspaceId.length > 0 && actual.executionMode === 'local' &&
    actual.autoApply === false && actual.state === 'verified-managed-state' &&
    typeof actual.backendFingerprint === 'string' && actual.backendFingerprint.length > 0 &&
    typeof actual.stateVersionId === 'string' && actual.stateVersionId.length > 0 &&
    Number.isSafeInteger(actual.serial) && actual.serial >= 0 &&
    typeof actual.inventoryHash === 'string' && actual.inventoryHash.length > 0;
}

function assertSameStateIdentity(first, next) {
  if (!sameStateIdentity(first) || !sameStateIdentity(next) ||
      !['organization', 'plan', 'workspace', 'workspaceId', 'executionMode', 'autoApply', 'state', 'backendFingerprint',
        'stateVersionId', 'serial', 'inventoryHash'].every((key) => first[key] === next[key])) {
    throw new Error('HCP workspace or managed-state identity changed. Stop for manual review.');
  }
}

async function defaultRunTerraform(args, { cwd, env, signal, input }) {
  return await new Promise((resolve, reject) => {
    const child = spawn('terraform', args, { cwd, env, signal, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdoutText = '';
    let stderrText = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdoutText += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderrText += chunk; });
    child.once('error', () => reject(new Error('Terraform command could not be started.')));
    child.once('close', (code) => resolve({ code, stdout: stdoutText, stderr: stderrText }));
    if (input) child.stdin.end(input);
    else child.stdin.end();
  });
}

function safeTerraformEnvironment(secrets) {
  const keys = ['PATH', 'HOME', 'TMPDIR', 'TEMP', 'TMP', 'SSL_CERT_FILE', 'SSL_CERT_DIR'];
  const env = Object.fromEntries(keys.filter((key) => process.env[key]).map((key) => [key, process.env[key]]));
  return {
    ...env,
    AUTH0_DOMAIN: secrets.auth0Domain,
    AUTH0_CLIENT_ID: secrets.auth0ClientId,
    AUTH0_CLIENT_SECRET: secrets.auth0ClientSecret,
    TF_VAR_auth0_domain: secrets.auth0Domain,
    TF_IN_AUTOMATION: '1', TF_INPUT: '0', TF_LOG: 'off',
  };
}

async function requireSuccess(runTerraform, args, context) {
  const result = await runTerraform(args, context);
  if (!result || result.code !== 0) throw new Error('Terraform operation failed; inspect the local workspace manually before continuing.');
  return result;
}

async function createPrivatePlanDirectory({ lstatImpl = lstat, chmodImpl = chmod, readdirImpl = readdir,
  mkdtempImpl = mkdtemp, rmImpl = rm }) {
  const metadata = await lstatImpl(metadataDirectory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error('Terraform metadata directory is not a safe directory.');
  if ((metadata.mode & 0o077) !== 0) await chmodImpl(metadataDirectory, 0o700);
  const entries = await readdirImpl(metadataDirectory);
  if (entries.some((entry) => entry.startsWith(artifactPrefix))) {
    throw new Error('A previous private plan artifact exists. Stop for manual review; it was not removed.');
  }
  const directory = await mkdtempImpl(path.join(metadataDirectory, artifactPrefix));
  try { await chmodImpl(directory, 0o700); }
  catch {
    try { await rmImpl(directory, { recursive: true, force: false }); }
    catch { throw new Error('Private plan directory setup and cleanup failed. Stop for manual review.'); }
    throw new Error('Private plan directory permissions could not be secured.');
  }
  return directory;
}

async function cleanupPrivatePlan(directory, { rmImpl = rm } = {}) {
  if (!directory) return;
  try { await rmImpl(directory, { recursive: true, force: false }); }
  catch { throw new Error('Private Terraform plan cleanup failed. Stop and remove the private artifact manually.'); }
}

function fullFingerprint(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
function exactApprovalText(fingerprint) {
  return `APPLY ${organizationName}/${workspaceName} ${targetAddress} ${fingerprint}`;
}

/** Orchestrator is dependency-injected so tests cannot invoke a real Terraform executable. */
export async function runBrowserOriginUpdateGate(deps = {}) {
  const runTerraform = deps.runTerraform;
  const verifyHcp = deps.verifyHcp;
  const configLoader = deps.loadConfiguration;
  const approve = deps.requestApproval;
  if ([runTerraform, verifyHcp, configLoader, approve].some((dependency) => typeof dependency !== 'function')) {
    throw new Error('The gated workflow requires explicit Terraform, HCP, configuration, and approval adapters.');
  }
  const now = deps.now ?? Date.now;
  const signal = deps.signal;
  const io = deps.io ?? {};
  const fsDeps = deps.fs ?? {};
  const directory = await createPrivatePlanDirectory(fsDeps);
  let operationError;
  let outcome;
  try {
    if (signal?.aborted) throw new Error('Operation interrupted; no automatic retry was attempted.');
    const secrets = await configLoader();
    const context = { cwd: moduleDirectory, env: safeTerraformEnvironment(secrets), signal };
    const stateBefore = await verifyHcp({ mode: 'reinit', terraformRoot: moduleDirectory });
    if (!sameStateIdentity(stateBefore)) throw new Error('HCP preflight did not verify the expected managed workspace and state.');
    await requireSuccess(runTerraform, ['plan', '-input=false', '-no-color', `-out=${path.join(directory, 'reviewed.tfplan')}`], context);
    const planPath = path.join(directory, 'reviewed.tfplan');
    const planStat = await (fsDeps.lstatImpl ?? lstat)(planPath);
    if (!planStat.isFile() || planStat.isSymbolicLink()) throw new Error('Terraform plan artifact is not a regular file.');
    await (fsDeps.chmodImpl ?? chmod)(planPath, 0o600);
    const securedPlanStat = await (fsDeps.lstatImpl ?? lstat)(planPath);
    if (!securedPlanStat.isFile() || securedPlanStat.isSymbolicLink() || (securedPlanStat.mode & 0o077) !== 0) {
      throw new Error('Terraform plan artifact permissions could not be secured.');
    }
    const planBytes = await (fsDeps.readFileImpl ?? readFile)(planPath);
    const fingerprint = fullFingerprint(planBytes);
    const shown = await requireSuccess(runTerraform, ['show', '-json', planPath], context);
    let document;
    try { document = JSON.parse(shown.stdout); }
    catch { throw new Error('Terraform returned malformed plan JSON; stop for manual review.'); }
    const summary = validateBrowserOriginUpdatePlan(document, { spaName: secrets.spaName, spaClientId: secrets.spaClientId });
    document = null;
    if (signal?.aborted) throw new Error('Operation interrupted; no automatic retry was attempted.');

    io.write?.(`Reviewed Terraform plan SHA-256: ${fingerprint}\n`);
    io.write?.(`Workspace: ${organizationName}/${workspaceName}; resource: ${targetAddress}\n`);
    io.write?.(`Callback URLs: ${summary.before.callbacks.join(', ')} -> ${summary.after.callbacks.join(', ')}\n`);
    io.write?.(`Web origins and logout URLs: ${summary.before.web_origins.join(', ')} -> ${summary.after.web_origins.join(', ')}\n`);
    const createdAt = now();
    const accepted = await approve(exactApprovalText(fingerprint), { organization: organizationName, workspace: workspaceName,
      resource: targetAddress, fingerprint, expiresAt: createdAt + approvalLifetimeMs, signal });
    if (accepted !== true || now() - createdAt > approvalLifetimeMs) throw new Error('Interactive approval was missing, incorrect, or expired.');
    if (signal?.aborted) throw new Error('Operation interrupted; no automatic retry was attempted.');

    const afterApproval = await verifyHcp({ mode: 'reinit', terraformRoot: moduleDirectory });
    assertSameStateIdentity(stateBefore, afterApproval);
    const currentPlanBytes = await (fsDeps.readFileImpl ?? readFile)(planPath);
    if (fullFingerprint(currentPlanBytes) !== fingerprint) throw new Error('Reviewed plan changed after authorization.');
    const reShown = await requireSuccess(runTerraform, ['show', '-json', planPath], context);
    let revalidated;
    try { revalidated = validateBrowserOriginUpdatePlan(JSON.parse(reShown.stdout), { spaName: secrets.spaName, spaClientId: secrets.spaClientId }); }
    catch { throw new Error('Saved plan no longer matches the reviewed update. Stop for manual review.'); }
    if (!same(revalidated, summary)) throw new Error('Saved plan differs from the reviewed update.');
    if (signal?.aborted) throw new Error('Operation interrupted; no automatic retry was attempted.');

    const immediatelyBeforeApply = await verifyHcp({ mode: 'reinit', terraformRoot: moduleDirectory });
    assertSameStateIdentity(stateBefore, immediatelyBeforeApply);
    if (fullFingerprint(await (fsDeps.readFileImpl ?? readFile)(planPath)) !== fingerprint) {
      throw new Error('Reviewed plan changed immediately before application.');
    }
    if (signal?.aborted) throw new Error('Operation interrupted; no automatic retry was attempted.');
    await requireSuccess(runTerraform, ['apply', '-input=false', '-no-color', planPath], context);
    outcome = Object.freeze({ fingerprint, applied: true });
  } catch (error) {
    operationError = error;
  }
  let cleanupError;
  try { await cleanupPrivatePlan(directory, fsDeps); }
  catch (error) { cleanupError = error; }
  if (cleanupError) throw cleanupError;
  if (operationError) throw operationError;
  return outcome;
}

async function requestInteractiveApproval(challenge, { signal } = {}) {
  const readline = createInterface({ input: stdin, output: stdout });
  try {
    return await settleApprovalOnAbort(readline.question(`Type exactly:\n${challenge}\n> `).then((answer) => answer === challenge), signal);
  } finally { readline.close(); }
}

export function settleApprovalOnAbort(approvalPromise, signal) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (accepted) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      resolve(accepted);
    };
    const onAbort = () => finish(false);
    if (signal?.aborted) { finish(false); return; }
    signal?.addEventListener('abort', onAbort, { once: true });
    Promise.resolve(approvalPromise)
      .then((accepted) => finish(accepted === true))
      .catch(() => finish(false));
  });
}

async function main() {
  assertInteractiveInvocation();
  const controller = new AbortController();
  const onInterrupt = () => controller.abort();
  const originalUmask = process.umask(0o077);
  process.once('SIGINT', onInterrupt);
  process.once('SIGTERM', onInterrupt);
  try {
    await runBrowserOriginUpdateGate({
      runTerraform: defaultRunTerraform,
      verifyHcp: (options) => verifyHcpConfiguration({ ...options, home: os.homedir() }),
      loadConfiguration: loadLocalConfiguration,
      requestApproval: requestInteractiveApproval,
      signal: controller.signal,
      io: { write: (message) => stdout.write(message) },
    });
  } finally {
    process.removeListener('SIGINT', onInterrupt);
    process.removeListener('SIGTERM', onInterrupt);
    process.umask(originalUmask);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : 'Unknown failure.';
    // Errors from Terraform and HCP are intentionally not surfaced; messages are locally authored and sanitized.
    stdout.write(`Browser-origin update gate stopped: ${message}\n`);
    process.exitCode = 1;
  });
}

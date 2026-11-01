#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { chmod, lstat, mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { stdin, stdout } from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { verifyHcpConfiguration } from './hcp-preflight.mjs';
import { createLocalConfigurationLoader, isAutomatedContext } from './apply-browser-origin-update.mjs';

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
const metadataDirectory = path.join(moduleDirectory, '.terraform');
const artifactPrefix = '.aegis-browser-origin-diagnostic-';
const maxCapturedBytes = 32 * 1024 * 1024;
const requiredFields = ['format_version', 'terraform_version', 'errored', 'complete', 'applyable', 'resource_changes'];
const optionalFields = ['resource_drift', 'deferred_changes', 'action_invocations', 'output_changes'];

function record(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }

function safeVersion(value) {
  return typeof value === 'string' && /^\d+\.\d+(?:\.\d+)?(?:-[A-Za-z0-9.]+)?(?:\+[A-Za-z0-9.]+)?$/.test(value) &&
    value.length <= 64 ? value : null;
}

function actionSummary(changes) {
  if (!Array.isArray(changes) || changes.some((item) => !record(item) || !record(item.change) ||
      !Array.isArray(item.change.actions) || item.change.actions.some((action) => typeof action !== 'string'))) {
    return { add: null, update: null, destroy: null, unclassified: null, matchesExpected: null };
  }
  let add = 0;
  let update = 0;
  let destroy = 0;
  let unclassified = 0;
  for (const item of changes) {
    const actions = item.change.actions;
    if (actions.includes('create')) add += 1;
    if (actions.includes('delete')) destroy += 1;
    if (actions.length === 1 && actions[0] === 'update') update += 1;
    if (!['no-op', 'create', 'update', 'delete'].includes(actions.join(',')) &&
        !(['delete', 'create'].every((action) => actions.includes(action)) && actions.length === 2)) unclassified += 1;
  }
  return { add, update, destroy, unclassified,
    matchesExpected: add === 0 && update === 1 && destroy === 0 && unclassified === 0 };
}

function countField(document, key) {
  if (key === 'output_changes') return record(document?.[key]) ? Object.keys(document[key]).length : null;
  return Array.isArray(document?.[key]) ? document[key].length : null;
}

/** Return only allowlisted plan metadata and rule identifiers; never return plan values. */
export function diagnosePlanDocument(document) {
  const isObject = record(document);
  const requiredPresent = Object.fromEntries(requiredFields.map((key) => [key, isObject && Object.hasOwn(document, key)]));
  const optionalPresent = Object.fromEntries(optionalFields.map((key) => [key, isObject && Object.hasOwn(document, key)]));
  const formatVersion = safeVersion(document?.format_version);
  const terraformVersion = safeVersion(document?.terraform_version);
  const errors = [];

  if (!isObject) errors.push('plan.document.object');
  if (typeof document?.format_version !== 'string') errors.push('plan.format_version.string');
  else if (!/^1\.\d+$/.test(document.format_version)) errors.push('plan.format_version.supported_major');
  if (typeof document?.terraform_version !== 'string') errors.push('plan.terraform_version.string');
  if (document?.errored !== false) errors.push('plan.errored.false');
  if (document?.complete !== true) errors.push('plan.complete.true');
  if (document?.applyable !== true) errors.push('plan.applyable.true');
  if (!Array.isArray(document?.resource_changes)) errors.push('plan.resource_changes.array');
  if (isObject && document.resource_drift !== undefined &&
      (!Array.isArray(document.resource_drift) || document.resource_drift.length !== 0)) {
    errors.push('plan.resource_drift.absent_or_empty_array');
  }
  if (isObject && document.deferred_changes !== undefined &&
      (!Array.isArray(document.deferred_changes) || document.deferred_changes.length !== 0)) {
    errors.push('plan.deferred_changes.absent_or_empty_array');
  }
  if (isObject && document.action_invocations !== undefined &&
      (!Array.isArray(document.action_invocations) || document.action_invocations.length !== 0)) {
    errors.push('plan.action_invocations.absent_or_empty_array');
  }
  if (isObject && document.output_changes !== undefined &&
      (!record(document.output_changes) || Object.keys(document.output_changes).length !== 0)) {
    errors.push('plan.output_changes.absent_or_empty_object');
  }

  const actions = actionSummary(document?.resource_changes);
  if (Array.isArray(document?.resource_changes) && actions.matchesExpected === null) {
    errors.push('plan.resource_changes.items.actions_array');
  } else if (actions.matchesExpected === false) errors.push('plan.actions.expected_0_add_1_update_0_destroy');
  return Object.freeze({
    formatVersion,
    terraformVersion,
    requiredFields: requiredPresent,
    optionalFields: optionalPresent,
    booleans: {
      errored: typeof document?.errored === 'boolean' ? document.errored : null,
      complete: typeof document?.complete === 'boolean' ? document.complete : null,
      applyable: typeof document?.applyable === 'boolean' ? document.applyable : null,
      expected: { errored: false, complete: true, applyable: true },
    },
    counts: {
      resourceChanges: countField(document, 'resource_changes'),
      resourceDrift: countField(document, 'resource_drift'),
      deferredChanges: countField(document, 'deferred_changes'),
      actionInvocations: countField(document, 'action_invocations'),
      outputChanges: countField(document, 'output_changes'),
    },
    actionCounts: actions,
    failedValidationRuleIds: Object.freeze(errors),
  });
}

export function diagnosePlanJson(jsonText) {
  let document;
  try { document = JSON.parse(jsonText); }
  catch {
    return Object.freeze({
      formatVersion: null, terraformVersion: null,
      requiredFields: Object.fromEntries(requiredFields.map((key) => [key, false])),
      optionalFields: Object.fromEntries(optionalFields.map((key) => [key, false])),
      booleans: { errored: null, complete: null, applyable: null,
        expected: { errored: false, complete: true, applyable: true } },
      counts: { resourceChanges: null, resourceDrift: null, deferredChanges: null, actionInvocations: null, outputChanges: null },
      actionCounts: { add: null, update: null, destroy: null, unclassified: null, matchesExpected: null },
      failedValidationRuleIds: Object.freeze(['plan.json.parse']),
    });
  }
  return diagnosePlanDocument(document);
}

export function sameHcpIdentity(left, right) {
  const fields = ['organization', 'plan', 'workspace', 'workspaceId', 'executionMode', 'autoApply', 'state',
    'backendFingerprint', 'stateVersionId', 'serial', 'inventoryHash'];
  const valid = (value) => record(value) && fields.every((key) => Object.hasOwn(value, key)) &&
    value.organization === 'aegis-ai-portfolio' && value.plan === 'free' && value.workspace === 'aegis-auth0-dev' &&
    typeof value.workspaceId === 'string' && value.workspaceId.length > 0 && value.executionMode === 'local' &&
    value.autoApply === false && value.state === 'verified-managed-state' &&
    /^[a-f0-9]{64}$/.test(value.backendFingerprint) && typeof value.stateVersionId === 'string' && value.stateVersionId.length > 0 &&
    Number.isSafeInteger(value.serial) && value.serial > 0 && /^[a-f0-9]{64}$/.test(value.inventoryHash);
  return valid(left) && valid(right) && fields.every((key) => left[key] === right[key]);
}

async function createPrivateDirectory({ lstatImpl = lstat, chmodImpl = chmod, readdirImpl = readdir,
  mkdtempImpl = mkdtemp, rmImpl = rm } = {}) {
  const metadata = await lstatImpl(metadataDirectory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error('Terraform metadata directory is unsafe.');
  if ((metadata.mode & 0o077) !== 0) await chmodImpl(metadataDirectory, 0o700);
  if ((await lstatImpl(metadataDirectory)).mode & 0o077) throw new Error('Terraform metadata permissions are too broad.');
  const entries = await readdirImpl(metadataDirectory);
  if (entries.some((entry) => entry.startsWith(artifactPrefix) || entry.startsWith('.aegis-browser-origin-update-'))) {
    throw new Error('A stale diagnostic plan artifact exists; it was not opened or changed. Stop for manual review.');
  }
  const directory = await mkdtempImpl(path.join(metadataDirectory, artifactPrefix));
  try {
    await chmodImpl(directory, 0o700);
    const secured = await lstatImpl(directory);
    if (!secured.isDirectory() || secured.isSymbolicLink() || (secured.mode & 0o077) !== 0) {
      throw new Error('unsafe private diagnostic directory');
    }
  }
  catch {
    try { await rmImpl(directory, { recursive: true, force: false }); }
    catch { throw new Error('Private diagnostic setup and cleanup failed; inspect the local artifact manually.'); }
    throw new Error('Private diagnostic directory permissions failed; inspect the local artifact manually.');
  }
  return directory;
}

async function removePrivateDirectory(directory, { rmImpl = rm } = {}) {
  try { await rmImpl(directory, { recursive: true, force: false }); }
  catch { throw new Error('Private diagnostic cleanup failed; inspect the artifact manually.'); }
}

async function captureTerraform(args, { cwd, env, signal, spawnImpl = spawn }) {
  return await new Promise((resolve, reject) => {
    const child = spawnImpl('terraform', args, { cwd, env, signal, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdoutText = '';
    let stderrText = '';
    let byteLength = 0;
    let overflow = false;
    let spawnFailed = false;
    const collect = (target, chunk) => {
      byteLength += Buffer.byteLength(chunk);
      if (byteLength > maxCapturedBytes) {
        overflow = true;
        child.kill('SIGTERM');
        return;
      }
      if (target === 'stdout') stdoutText += chunk;
      else stderrText += chunk;
    };
    child.stdout.setEncoding('utf8').on('data', (chunk) => collect('stdout', chunk));
    child.stderr.setEncoding('utf8').on('data', (chunk) => collect('stderr', chunk));
    // Node emits `close` after `error`; wait for termination before the caller
    // removes the private directory, especially when AbortSignal cancels a child.
    child.once('error', () => { spawnFailed = true; });
    child.once('close', (code) => {
      if (spawnFailed) reject(new Error('Terraform diagnostic command could not be started.'));
      else if (overflow) reject(new Error('Terraform diagnostic output exceeded its safe memory limit.'));
      else if (code !== 0) reject(new Error('Terraform diagnostic command failed; details were suppressed.'));
      else resolve({ stdout: stdoutText, stderr: stderrText });
    });
  });
}

function terraformEnvironment(config, env = process.env) {
  const inherited = Object.fromEntries(['PATH', 'HOME', 'TMPDIR', 'TEMP', 'TMP', 'SSL_CERT_FILE', 'SSL_CERT_DIR']
    .filter((key) => env[key]).map((key) => [key, env[key]]));
  return { ...inherited, AUTH0_DOMAIN: config.auth0Domain, AUTH0_CLIENT_ID: config.auth0ClientId,
    AUTH0_CLIENT_SECRET: config.auth0ClientSecret, TF_VAR_auth0_domain: config.auth0Domain,
    TF_IN_AUTOMATION: '1', TF_INPUT: '0', TF_LOG: 'off' };
}

/** Fixed read-only orchestration: this module has no Terraform apply path. */
export async function runPlanDiagnostic(deps = {}) {
  const { verifyHcp, loadConfiguration, runPlan, showPlan } = deps;
  if (![verifyHcp, loadConfiguration, runPlan, showPlan].every((fn) => typeof fn === 'function')) {
    throw new Error('Read-only diagnostic adapters are incomplete.');
  }
  const fs = deps.fs ?? {};
  const signal = deps.signal;
  const stateBefore = await verifyHcp({ mode: 'reinit', terraformRoot: moduleDirectory });
  if (!sameHcpIdentity(stateBefore, stateBefore)) throw new Error('HCP state ownership did not verify.');
  const config = await loadConfiguration();
  const directory = await createPrivateDirectory(fs);
  let result;
  let operationError;
  try {
    if (signal?.aborted) throw new Error('Diagnostic cancelled.');
    const planPath = path.join(directory, 'diagnostic.tfplan');
    const context = { cwd: moduleDirectory, env: terraformEnvironment(config, deps.env), signal };
    await runPlan(planPath, context);
    const planStat = await (fs.lstatImpl ?? lstat)(planPath);
    if (!planStat.isFile() || planStat.isSymbolicLink()) throw new Error('Diagnostic plan artifact is not a regular file.');
    await (fs.chmodImpl ?? chmod)(planPath, 0o600);
    const securedPlanStat = await (fs.lstatImpl ?? lstat)(planPath);
    if (!securedPlanStat.isFile() || securedPlanStat.isSymbolicLink() || (securedPlanStat.mode & 0o077) !== 0) {
      throw new Error('Diagnostic plan artifact permissions are too broad.');
    }
    const stateAfterPlan = await verifyHcp({ mode: 'reinit', terraformRoot: moduleDirectory });
    if (!sameHcpIdentity(stateBefore, stateAfterPlan)) throw new Error('HCP state identity changed during diagnostics.');
    if (signal?.aborted) throw new Error('Diagnostic cancelled.');
    const json = await showPlan(planPath, context);
    const stateAfterShow = await verifyHcp({ mode: 'reinit', terraformRoot: moduleDirectory });
    if (!sameHcpIdentity(stateBefore, stateAfterShow)) throw new Error('HCP state identity changed during diagnostics.');
    if (signal?.aborted) throw new Error('Diagnostic cancelled.');
    result = diagnosePlanJson(json);
  } catch (error) {
    operationError = error;
  }
  let cleanupError;
  try { await removePrivateDirectory(directory, fs); }
  catch (error) { cleanupError = error; }
  if (cleanupError) throw cleanupError;
  if (operationError) throw new Error('Read-only plan diagnostic failed safely; details were suppressed.');
  return result;
}

export function createTerraformDiagnosticAdapters({ spawnImpl = spawn, env = process.env } = {}) {
  return {
    runPlan: async (planPath, context) => {
      const args = ['plan', '-input=false', '-no-color', `-out=${planPath}`];
      await captureTerraform(args, { ...context, spawnImpl });
    },
    showPlan: async (planPath, context) => {
      const result = await captureTerraform(['show', '-json', planPath], { ...context, env: context.env ?? env, spawnImpl });
      return result.stdout;
    },
  };
}

export function assertDiagnosticInvocation({ argv = process.argv, stdinIsTTY = stdin.isTTY,
  stdoutIsTTY = stdout.isTTY, env = process.env } = {}) {
  if (argv.length !== 2 || !stdinIsTTY || !stdoutIsTTY || isAutomatedContext(env)) {
    throw new Error('Diagnostic requires a direct interactive terminal and accepts no arguments.');
  }
}

async function main() {
  assertDiagnosticInvocation();
  const originalUmask = process.umask(0o077);
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.once('SIGINT', abort);
  process.once('SIGTERM', abort);
  try {
    const configLoader = createLocalConfigurationLoader();
    const result = await runPlanDiagnostic({
      verifyHcp: (options) => verifyHcpConfiguration({ ...options, home: os.homedir() }),
      loadConfiguration: () => configLoader(),
      ...createTerraformDiagnosticAdapters(),
      signal: controller.signal,
    });
    stdout.write(`${JSON.stringify(result)}\n`);
  } finally {
    process.removeListener('SIGINT', abort);
    process.removeListener('SIGTERM', abort);
    process.umask(originalUmask);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(() => {
    stdout.write('Read-only plan diagnostic stopped safely; no plan details were emitted.\n');
    process.exitCode = 1;
  });
}

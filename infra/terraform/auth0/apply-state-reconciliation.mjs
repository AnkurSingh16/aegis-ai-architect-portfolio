#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { chmod, lstat, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { verifyHcpConfiguration } from './hcp-preflight.mjs';
import { createLocalConfigurationLoader, isAutomatedContext } from './apply-browser-origin-update.mjs';
import { parsePinnedAuth0ProviderVersion, sameHcpIdentity } from './diagnose-browser-origin-plan.mjs';
import { expectedDriftShapes, expectedResourceAddresses, validateRefreshOnlyPlan } from './plan-state-reconciliation.mjs';

export const organizationName = 'aegis-ai-portfolio';
export const workspaceName = 'aegis-auth0-dev';
export const reviewConfirmation = 'REVIEWED aegis-ai-portfolio/aegis-auth0-dev allowed_clients-null-to-empty-array async_approval_notification_channels-null-to-empty-array client_aliases-null-to-empty-array client_metadata-null-to-empty-object delegation-implications';
export const approvalLifetimeMs = 5 * 60 * 1000;
const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
const metadataDirectory = path.join(moduleDirectory, '.terraform');
const artifactPrefix = '.aegis-state-reconciliation-apply-';
const stalePrefixes = [
  '.aegis-state-reconciliation-', '.aegis-browser-origin-diagnostic-',
  '.aegis-browser-origin-update-', '.aegis-first-deployment-',
];
const maxCapturedBytes = 32 * 1024 * 1024;

function record(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function sameWorkspaceAndBackend(left, right) {
  return record(left) && record(right) &&
    ['organization', 'plan', 'workspace', 'workspaceId', 'executionMode', 'autoApply', 'backendFingerprint']
      .every((key) => Object.hasOwn(left, key) && left[key] === right[key]) &&
    left.organization === organizationName && left.plan === 'free' && left.workspace === workspaceName &&
    left.executionMode === 'local' && left.autoApply === false;
}
function postApplyStateIsVerified(before, after) {
  return sameWorkspaceAndBackend(before, after) && after.state === 'reviewable-managed-state' &&
    typeof after.stateVersionId === 'string' && after.stateVersionId.length > 0 &&
    after.stateVersionId !== before.stateVersionId && Number.isSafeInteger(after.serial) && after.serial > before.serial &&
    after.inventoryHash === before.inventoryHash && /^[a-f0-9]{64}$/.test(after.inventoryHash);
}
function inheritedEnvironment(source = process.env) {
  return Object.fromEntries(['PATH', 'HOME', 'TMPDIR', 'TEMP', 'TMP', 'SSL_CERT_FILE', 'SSL_CERT_DIR']
    .filter((key) => source[key]).map((key) => [key, source[key]]));
}
function terraformEnvironment(config, source = process.env) {
  return { ...inheritedEnvironment(source), AUTH0_DOMAIN: config.auth0Domain, AUTH0_CLIENT_ID: config.auth0ClientId,
    AUTH0_CLIENT_SECRET: config.auth0ClientSecret, TF_VAR_auth0_domain: config.auth0Domain,
    TF_IN_AUTOMATION: '1', TF_INPUT: '0', TF_LOG: 'off' };
}
function schemaEnvironment(source = process.env) {
  return { ...inheritedEnvironment(source), TF_IN_AUTOMATION: '1', TF_INPUT: '0', TF_LOG: 'off' };
}

async function createPrivateDirectory(fs = {}) {
  const lstatImpl = fs.lstatImpl ?? lstat;
  const chmodImpl = fs.chmodImpl ?? chmod;
  const metadata = await lstatImpl(metadataDirectory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error('Terraform metadata directory is unsafe.');
  if ((metadata.mode & 0o077) !== 0) await chmodImpl(metadataDirectory, 0o700);
  if (((await lstatImpl(metadataDirectory)).mode & 0o077) !== 0) throw new Error('Terraform metadata permissions are too broad.');
  const entries = await (fs.readdirImpl ?? readdir)(metadataDirectory);
  if (entries.some((entry) => stalePrefixes.some((prefix) => entry.startsWith(prefix)))) {
    throw new Error('A prior private Terraform artifact exists; it was not opened or changed. Stop for manual review.');
  }
  const directory = await (fs.mkdtempImpl ?? mkdtemp)(path.join(metadataDirectory, artifactPrefix));
  try {
    await chmodImpl(directory, 0o700);
    const secured = await lstatImpl(directory);
    if (!secured.isDirectory() || secured.isSymbolicLink() || (secured.mode & 0o777) !== 0o700) throw new Error('unsafe directory');
  } catch {
    try { await (fs.rmImpl ?? rm)(directory, { recursive: true, force: false }); }
    catch { throw new Error('Private plan setup and cleanup failed; inspect the local artifact manually.'); }
    throw new Error('Private plan directory permissions could not be verified.');
  }
  return directory;
}
async function removePrivateDirectory(directory, fs = {}) {
  try { await (fs.rmImpl ?? rm)(directory, { recursive: true, force: false }); }
  catch { throw new Error('Private plan cleanup failed; stop for manual artifact review.'); }
}
function isPrivateRegularPlan(info) {
  return info?.isFile?.() === true && info?.isSymbolicLink?.() === false && (info.mode & 0o777) === 0o600;
}
async function hashSavedPlan(planPath, fs = {}) {
  const lstatImpl = fs.lstatImpl ?? lstat;
  const before = await lstatImpl(planPath);
  if (!isPrivateRegularPlan(before)) throw new Error('Saved plan is not a private regular file.');
  const bytes = await (fs.readFileImpl ?? readFile)(planPath);
  const after = await lstatImpl(planPath);
  if (!isPrivateRegularPlan(after) || before.dev !== after.dev || before.ino !== after.ino ||
      before.size !== after.size || before.mtimeMs !== after.mtimeMs || bytes.length !== after.size) {
    throw new Error('Saved plan changed while it was being fingerprinted.');
  }
  return createHash('sha256').update(bytes).digest('hex');
}
async function captureTerraform(args, { cwd, env, signal, captureStdout = true, spawnImpl = spawn }) {
  return await new Promise((resolve, reject) => {
    const child = spawnImpl('terraform', args, { cwd, env, signal, stdio: ['ignore', 'pipe', 'pipe'] });
    let bytes = 0;
    let overflow = false;
    let spawnFailed = false;
    let out = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > maxCapturedBytes) { overflow = true; child.kill('SIGTERM'); }
      else if (captureStdout) out += chunk;
    });
    child.stderr.setEncoding('utf8').on('data', () => {});
    child.once('error', () => { spawnFailed = true; });
    child.once('close', (code) => {
      if (spawnFailed) reject(new Error('Terraform operation could not be started.'));
      else if (overflow) reject(new Error('Terraform output exceeded the in-memory safety limit.'));
      else if (code !== 0) reject(new Error('Terraform operation failed; details were suppressed.'));
      else resolve(out);
    });
  });
}
export function createStateReconciliationAdapters({ spawnImpl = spawn } = {}) {
  return {
    runProviderSchema: async (context) => await captureTerraform(['providers', 'schema', '-json'], { ...context, spawnImpl }),
    runPlan: async (planPath, context) => await captureTerraform(
      ['plan', '-refresh-only', '-input=false', '-no-color', '-lock=true', `-out=${planPath}`], { ...context, captureStdout: false, spawnImpl }),
    showPlan: async (planPath, context) => await captureTerraform(['show', '-json', planPath], { ...context, spawnImpl }),
    applyPlan: async (planPath, context) => await captureTerraform(
      ['apply', '-input=false', '-no-color', '-lock=true', planPath], { ...context, captureStdout: false, spawnImpl }),
  };
}

/** Apply only the fresh, validated refresh-only saved plan after two explicit terminal approvals. */
export async function runStateReconciliationApply(deps = {}) {
  const { verifyHcp, loadConfiguration, getPinnedProviderVersion, runProviderSchema, runPlan, showPlan,
    approveReviewedSettings, confirmFingerprint, applyPlan } = deps;
  if (![verifyHcp, loadConfiguration, getPinnedProviderVersion, runProviderSchema, runPlan, showPlan,
    approveReviewedSettings, confirmFingerprint, applyPlan].every((fn) => typeof fn === 'function')) {
    throw new Error('State reconciliation apply adapters are incomplete.');
  }
  const fs = deps.fs ?? {};
  const signal = deps.signal;
  const originalState = await verifyHcp({ mode: 'reinit', terraformRoot: moduleDirectory });
  if (!sameHcpIdentity(originalState, originalState)) throw new Error('Verified HCP state identity is unavailable.');
  if (await getPinnedProviderVersion() !== '1.59.0') throw new Error('Pinned Auth0 provider version did not verify.');
  const config = await loadConfiguration();
  const directory = await createPrivateDirectory(fs);
  let applyAttempted = false;
  let operationError;
  let result;
  try {
    if (signal?.aborted) throw new Error('cancelled');
    const planPath = path.join(directory, 'state-reconciliation.tfplan');
    const context = { cwd: moduleDirectory, env: terraformEnvironment(config, deps.env), signal };
    const schemaJson = await runProviderSchema({ cwd: moduleDirectory, env: schemaEnvironment(deps.env), signal });
    const stateAfterSchema = await verifyHcp({ mode: 'reinit', terraformRoot: moduleDirectory });
    if (!sameHcpIdentity(originalState, stateAfterSchema) || signal?.aborted) throw new Error('state changed or cancelled');

    await runPlan(planPath, context);
    const createdPlan = await (fs.lstatImpl ?? lstat)(planPath);
    if (!createdPlan.isFile() || createdPlan.isSymbolicLink()) throw new Error('plan file is not regular');
    await (fs.chmodImpl ?? chmod)(planPath, 0o600);
    if (!isPrivateRegularPlan(await (fs.lstatImpl ?? lstat)(planPath))) throw new Error('plan file mode');
    const stateAfterPlan = await verifyHcp({ mode: 'reinit', terraformRoot: moduleDirectory });
    if (!sameHcpIdentity(originalState, stateAfterPlan) || signal?.aborted) throw new Error('state changed or cancelled');

    const fingerprintBeforeInspection = await hashSavedPlan(planPath, fs);
    const json = await showPlan(planPath, context);
    const stateAfterShow = await verifyHcp({ mode: 'reinit', terraformRoot: moduleDirectory });
    if (!sameHcpIdentity(originalState, stateAfterShow) || signal?.aborted) throw new Error('state changed or cancelled');
    const displayedFingerprint = await hashSavedPlan(planPath, fs);
    if (displayedFingerprint !== fingerprintBeforeInspection) throw new Error('saved plan changed during inspection');
    let document;
    try { document = JSON.parse(json); } catch { throw new Error('plan JSON is malformed'); }
    const summary = validateRefreshOnlyPlan(document, schemaJson, await getPinnedProviderVersion());
    const createdAt = Date.now();

    const reviewAccepted = await approveReviewedSettings({
      summary,
      shapes: expectedDriftShapes,
      warning: 'allowed_clients is an Auth0 client delegation/access association setting. Confirm that clearing the explicitly associated clients is intended; do not assume an empty list is harmless.',
      signal,
    });
    if (reviewAccepted !== true || signal?.aborted) throw new Error('review was not accepted');
    const applyPhrase = await confirmFingerprint({ workspace: workspaceName, intent: 'state-only reconciliation',
      fingerprint: displayedFingerprint, signal });
    const requiredPhrase = `APPLY STATE ONLY ${organizationName}/${workspaceName} sha256:${displayedFingerprint}`;
    if (applyPhrase !== requiredPhrase || signal?.aborted || Date.now() - createdAt > approvalLifetimeMs) {
      throw new Error('state-write confirmation was invalid, expired, or cancelled');
    }

    const stateImmediatelyBeforeApply = await verifyHcp({ mode: 'reinit', terraformRoot: moduleDirectory });
    if (!sameHcpIdentity(originalState, stateImmediatelyBeforeApply) || signal?.aborted) throw new Error('state changed or cancelled');
    const actualFingerprint = await hashSavedPlan(planPath, fs);
    if (actualFingerprint !== displayedFingerprint || signal?.aborted || Date.now() - createdAt > approvalLifetimeMs) {
      throw new Error('saved plan changed, authorization expired, or operation cancelled');
    }
    // Terraform's saved-plan apply does not prompt. The preceding exact TTY phrase is the approval.
    applyAttempted = true;
    await applyPlan(planPath, context);
    if (signal?.aborted) throw new Error('cancelled after apply');
    const resultingState = await verifyHcp({ mode: 'bind', terraformRoot: moduleDirectory });
    if (!postApplyStateIsVerified(originalState, resultingState)) throw new Error('new HCP state version did not verify');
    result = Object.freeze({
      result: 'state-only-reconciliation-applied-and-verified',
      organization: organizationName,
      workspace: workspaceName,
      planFingerprintSha256: displayedFingerprint,
      refreshedResourceCount: expectedResourceAddresses.length,
      stateVersionAdvanced: true,
      inventoryUnchanged: true,
      localBindingUpdated: false,
      browserUpdatePerformed: false,
    });
  } catch (error) { operationError = error; }
  let cleanupError;
  try { await removePrivateDirectory(directory, fs); } catch (error) { cleanupError = error; }
  if (cleanupError) throw new Error(applyAttempted
    ? 'State-only apply was attempted but private-plan cleanup failed. The state write may have completed; do not retry. Inspect HCP metadata and inventory read-only, and review the leftover artifact manually.'
    : 'Private plan cleanup failed; stop for manual artifact review.');
  if (operationError) throw new Error(applyAttempted
    ? 'State-only apply did not complete cleanly or its post-apply state could not be verified. It may have partially written state; do not retry. Inspect HCP metadata and inventory read-only.'
    : 'State-only reconciliation stopped safely; no plan or credential details were emitted.');
  return result;
}

export function assertStateApplyInvocation({ argv = process.argv, stdinIsTTY = stdin.isTTY,
  stdoutIsTTY = stdout.isTTY, env = process.env } = {}) {
  if (argv.length !== 2 || !stdinIsTTY || !stdoutIsTTY || isAutomatedContext(env)) {
    throw new Error('State-only apply requires a direct interactive terminal and accepts no arguments.');
  }
}
export function confirmationPhrase(fingerprint) {
  if (typeof fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(fingerprint)) throw new Error('Plan fingerprint is malformed.');
  return `APPLY STATE ONLY ${organizationName}/${workspaceName} sha256:${fingerprint}`;
}
async function main() {
  assertStateApplyInvocation();
  const originalUmask = process.umask(0o077);
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.once('SIGINT', abort);
  process.once('SIGTERM', abort);
  const rl = createInterface({ input: stdin, output: stdout });
  rl.signal = controller.signal;
  try {
    const loader = createLocalConfigurationLoader();
    const result = await runStateReconciliationApply({
      verifyHcp: (options) => verifyHcpConfiguration({ ...options, home: os.homedir() }),
      loadConfiguration: () => loader(),
      getPinnedProviderVersion: async () => parsePinnedAuth0ProviderVersion(await readFile(path.join(moduleDirectory, '.terraform.lock.hcl'), 'utf8')),
      ...createStateReconciliationAdapters(),
      approveReviewedSettings: async ({ warning, summary }) => {
        stdout.write('\nSanitized candidate summary:\n');
        stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
        stdout.write('\nReviewed state-only values (current remote -> Terraform state):\n');
        stdout.write('  allowed_clients: null -> []\n');
        stdout.write('  async_approval_notification_channels: null -> []\n');
        stdout.write('  client_aliases: null -> []\n');
        stdout.write('  client_metadata: null -> {}\n');
        stdout.write(`Security review: ${warning}\n`);
        stdout.write('The plan does not change Auth0 settings. This approval accepts these exact remote values into Terraform state only.\n');
        const answer = await rl.question(`Type exactly: ${reviewConfirmation}\n> `, { signal: controller.signal });
        return answer === reviewConfirmation;
      },
      confirmFingerprint: async ({ fingerprint }) => {
        stdout.write(`Validated plan fingerprint (SHA-256): ${fingerprint}\n`);
        const phrase = confirmationPhrase(fingerprint);
        return await rl.question(`This saved-plan apply will write HCP Terraform state only; Terraform will not prompt for approval. Type exactly:\n${phrase}\n> `, { signal: controller.signal });
      },
      signal: controller.signal,
    });
    stdout.write(`${JSON.stringify(result)}\n`);
  } finally {
    rl.close();
    process.removeListener('SIGINT', abort);
    process.removeListener('SIGTERM', abort);
    process.umask(originalUmask);
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    const message = error instanceof Error && (error.message.startsWith('State-only apply did not complete') ||
      error.message.startsWith('State-only apply was attempted'))
      ? error.message
      : 'State-only reconciliation stopped safely; no secret, state, or plan details were emitted.';
    stdout.write(`${message}\n`);
    process.exitCode = 1;
  });
}

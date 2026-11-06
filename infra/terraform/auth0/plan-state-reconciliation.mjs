#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { chmod, lstat, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { isDeepStrictEqual } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { verifyHcpConfiguration } from './hcp-preflight.mjs';
import { createLocalConfigurationLoader, isAutomatedContext } from './apply-browser-origin-update.mjs';
import { parsePinnedAuth0ProviderVersion, sameHcpIdentity, summarizeDriftAgainstProviderSchema } from './diagnose-browser-origin-plan.mjs';

export const refreshOnlyConfirmation = 'PLAN ONLY aegis-ai-portfolio/aegis-auth0-dev refresh-only';
export const reconciliationDriftAddress = 'auth0_client.local_spa';
export const expectedDriftShapes = Object.freeze({
  allowed_clients: Object.freeze({ before: 'null', after: 'empty-array' }),
  async_approval_notification_channels: Object.freeze({ before: 'null', after: 'empty-array' }),
  client_aliases: Object.freeze({ before: 'null', after: 'empty-array' }),
  client_metadata: Object.freeze({ before: 'null', after: 'empty-object' }),
});
export const expectedResourceAddresses = Object.freeze([
  'auth0_resource_server.cases',
  'auth0_resource_server_scope.read_cases',
  'auth0_resource_server_scope.write_cases',
  reconciliationDriftAddress,
  'auth0_connection_client.local_spa_database',
]);
const expectedProvider = 'registry.terraform.io/auth0/auth0';
const expectedProviderVersion = '1.59.0';
const expectedOutputs = Object.freeze(['issuer', 'audience', 'spa_client_id']);
const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
const metadataDirectory = path.join(moduleDirectory, '.terraform');
const artifactPrefix = '.aegis-state-reconciliation-';
const otherArtifactPrefixes = ['.aegis-browser-origin-diagnostic-', '.aegis-browser-origin-update-', '.aegis-first-deployment-'];
const maxCapturedBytes = 32 * 1024 * 1024;

function record(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function containsTrue(value) {
  if (value === true) return true;
  if (Array.isArray(value)) return value.some(containsTrue);
  if (record(value)) return Object.values(value).some(containsTrue);
  return false;
}
function booleanTreeIsValid(value) {
  if (typeof value === 'boolean') return true;
  if (Array.isArray(value)) return value.every(booleanTreeIsValid);
  if (record(value)) return Object.values(value).every(booleanTreeIsValid);
  return false;
}
function maskMatchesValue(mask, value) {
  if (typeof mask === 'boolean') return true;
  if (Array.isArray(mask)) return Array.isArray(value) && mask.length === value.length &&
    mask.every((entry, index) => maskMatchesValue(entry, value[index]));
  if (record(mask)) return record(value) && Object.entries(mask).every(([key, entry]) =>
    Object.hasOwn(value, key) && maskMatchesValue(entry, value[key]));
  return false;
}
function shape(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return value.length === 0 ? 'empty-array' : 'nonempty-array';
  if (record(value)) return Object.keys(value).length === 0 ? 'empty-object' : 'nonempty-object';
  return 'other';
}
function changedKeys(change) {
  const before = record(change.before) ? change.before : {};
  const after = record(change.after) ? change.after : {};
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const field of ['before_sensitive', 'after_sensitive', 'after_unknown']) {
    if (record(change[field])) for (const key of Object.keys(change[field])) keys.add(key);
  }
  const metadataValid = ['before_sensitive', 'after_sensitive', 'after_unknown'].every((field) =>
    !Object.hasOwn(change, field) || booleanTreeIsValid(change[field]));
  if (!metadataValid) throw new Error('Plan contains malformed value metadata.');
  for (const field of ['before_sensitive', 'after_sensitive', 'after_unknown']) {
    if (Object.hasOwn(change, field)) {
      const valueRoot = field === 'before_sensitive' ? change.before : change.after;
      if (!maskMatchesValue(change[field], valueRoot)) throw new Error('Plan value metadata does not match its values.');
    }
  }
  return [...keys].filter((key) => {
    if (['before_sensitive', 'after_sensitive', 'after_unknown'].some((field) =>
      Object.hasOwn(change, field) && containsTrue(change[field]?.[key]))) return true;
    return !Object.hasOwn(before, key) || !Object.hasOwn(after, key) || !isDeepStrictEqual(before[key], after[key]);
  });
}
function sensitiveDriftKeys(schemaJson, pinnedVersion, keys) {
  let schema;
  try { schema = typeof schemaJson === 'string' ? JSON.parse(schemaJson) : schemaJson; } catch { return null; }
  const provider = schema?.provider_schemas?.[expectedProvider];
  const resource = provider?.resource_schemas?.auth0_client;
  const attributes = resource?.block?.attributes;
  if (pinnedVersion !== expectedProviderVersion || !record(schema) || !/^1\.\d+$/.test(schema.format_version ?? '') ||
      !record(provider) || !record(resource) || !Number.isSafeInteger(resource.version) || !record(attributes)) return null;
  const sensitive = [];
  for (const key of keys) {
    const attribute = attributes[key];
    if (!record(attribute)) continue;
    for (const flag of ['required', 'optional', 'computed', 'sensitive']) {
      if (Object.hasOwn(attribute, flag) && typeof attribute[flag] !== 'boolean') return null;
    }
    const required = attribute.required ?? false;
    const optional = attribute.optional ?? false;
    const computed = attribute.computed ?? false;
    if ((required && (optional || computed)) || (!required && !optional && !computed)) return null;
    if (attribute.sensitive === true) sensitive.push(key);
  }
  return sensitive;
}
function validateResourceAddress(item) {
  return record(item) && item.mode === 'managed' && item.address === `${item.type}.${item.name}` &&
    expectedResourceAddresses.includes(item.address) && item.provider_name === expectedProvider &&
    item.module_address === undefined && item.index === undefined && item.previous_address === undefined &&
    item.deposed === undefined && item.generated_config === undefined;
}
function verifyOutputNoOps(outputChanges) {
  if (outputChanges === undefined) return true;
  if (!record(outputChanges)) return false;
  const names = Object.keys(outputChanges);
  if (!names.length) return true;
  if (names.length !== expectedOutputs.length || expectedOutputs.some((name) => !Object.hasOwn(outputChanges, name))) return false;
  return expectedOutputs.every((name) => {
    const output = outputChanges[name];
    return record(output) && isDeepStrictEqual(output.actions, ['no-op']) &&
      Object.hasOwn(output, 'before') && Object.hasOwn(output, 'after') &&
      isDeepStrictEqual(output.before, output.after) && output.after_unknown === false &&
      output.before_sensitive === false && output.after_sensitive === false;
  });
}

/** Validate a refresh-only Terraform plan and return only fixed, sanitized metadata. */
export function validateRefreshOnlyPlan(document, schemaJson, pinnedVersion = expectedProviderVersion) {
  if (!record(document) || typeof document.format_version !== 'string' || !/^1\.\d+$/.test(document.format_version) ||
      typeof document.terraform_version !== 'string' || !/^\d+\.\d+\.\d+$/.test(document.terraform_version) ||
      document.errored !== false || document.complete !== true ||
      document.applyable !== true || (document.proposed_unknown !== undefined &&
        (!record(document.proposed_unknown) || containsTrue(document.proposed_unknown))) ||
      (document.resource_changes !== undefined && (!Array.isArray(document.resource_changes) || document.resource_changes.length !== 0)) ||
      !Array.isArray(document.resource_drift) ||
      (document.deferred_changes !== undefined && (!Array.isArray(document.deferred_changes) || document.deferred_changes.length !== 0)) ||
      (document.action_invocations !== undefined && (!Array.isArray(document.action_invocations) || document.action_invocations.length !== 0)) ||
      !verifyOutputNoOps(document.output_changes)) {
    throw new Error('Refresh-only plan is malformed, incomplete, or includes unsupported changes.');
  }
  // Terraform's refresh-only planner intentionally emits no resource_changes; drift is reported separately.
  if (document.resource_drift.length !== 1) throw new Error('Refresh-only plan drift does not match the reviewed state reconciliation.');
  const drift = document.resource_drift[0];
  if (!validateResourceAddress(drift) || drift.address !== reconciliationDriftAddress ||
      !record(drift.change) || !isDeepStrictEqual(drift.change.actions, ['update']) ||
      drift.change.importing !== undefined ||
      (drift.change.replace_paths !== undefined && (!Array.isArray(drift.change.replace_paths) || drift.change.replace_paths.length !== 0)) ||
      !record(drift.change.before) || !record(drift.change.after)) {
    throw new Error('Refresh-only plan drift identity or action is unexpected.');
  }
  const keys = changedKeys(drift.change);
  const safeNames = Object.keys(expectedDriftShapes).sort();
  const sensitiveKeys = sensitiveDriftKeys(schemaJson, pinnedVersion, keys);
  if (!sensitiveKeys || sensitiveKeys.length !== 1) throw new Error('Refresh-only sensitive drift could not be identified from the pinned provider schema.');
  const changedNonSensitive = keys.filter((key) => !sensitiveKeys.includes(key));
  if (!isDeepStrictEqual(changedNonSensitive.sort(), safeNames)) throw new Error('Refresh-only plan contains unapproved drift attributes.');
  for (const [attribute, expected] of Object.entries(expectedDriftShapes)) {
    const before = drift.change.before[attribute];
    const after = drift.change.after[attribute];
    if (shape(before) !== expected.before || shape(after) !== expected.after ||
        (expected.after === 'empty-array' && after.length !== 0) ||
        (expected.after === 'empty-object' && Object.keys(after).length !== 0) ||
        containsTrue(drift.change.after_unknown?.[attribute])) {
      throw new Error('Refresh-only plan does not match the approved drift shapes.');
    }
  }

  const providerSummary = summarizeDriftAgainstProviderSchema(document.resource_drift, schemaJson, pinnedVersion, document.resource_changes);
  const entry = providerSummary.entries?.[0];
  const sensitiveFindings = entry?.attributeFindings?.filter((finding) => finding.savedStateVsRefreshedRemoteSensitiveEquality !== undefined) ?? [];
  if (providerSummary.schemaAvailability !== 'available' || providerSummary.driftClassification !== 'complete' ||
      providerSummary.pinnedVersion !== expectedProviderVersion || !entry || entry.resource !== reconciliationDriftAddress ||
      !isDeepStrictEqual(entry.classifications, { computedOnly: 0, optionalComputed: 0, configurable: 4, sensitive: 1, unknownUnrecognized: 0 }) ||
      !isDeepStrictEqual(entry.safeNonSensitiveAttributeNames, safeNames) || entry.planUnknownValueCount !== 0 ||
      sensitiveFindings.length !== 1 || sensitiveFindings[0].savedStateVsRefreshedRemoteSensitiveEquality !== 'equal') {
    throw new Error('Pinned provider schema or sensitive drift equality could not be verified.');
  }
  return Object.freeze({
    result: 'accepted-read-only-refresh-plan',
    mode: 'refresh-only-plan',
    terraformVersion: document.terraform_version,
    jsonFormatVersion: document.format_version,
    stateInventoryCount: expectedResourceAddresses.length,
    resourceDriftCount: document.resource_drift.length,
    approvedShapeChanges: 4,
    sensitiveComparison: 'equal',
    outputChanges: 'none',
    remoteResourceActions: 0,
    stateWritePerformed: false,
  });
}

async function createPrivateDirectory(fs = {}) {
  const lstatImpl = fs.lstatImpl ?? lstat;
  const chmodImpl = fs.chmodImpl ?? chmod;
  const metadata = await lstatImpl(metadataDirectory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error('Terraform metadata directory is unsafe.');
  if ((metadata.mode & 0o077) !== 0) await chmodImpl(metadataDirectory, 0o700);
  if (((await lstatImpl(metadataDirectory)).mode & 0o077) !== 0) throw new Error('Terraform metadata permissions are too broad.');
  const entries = await (fs.readdirImpl ?? readdir)(metadataDirectory);
  if (entries.some((entry) => entry.startsWith(artifactPrefix) || otherArtifactPrefixes.some((prefix) => entry.startsWith(prefix)))) {
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
function safeTerraformEnvironment(config, source = process.env) {
  const inherited = Object.fromEntries(['PATH', 'HOME', 'TMPDIR', 'TEMP', 'TMP', 'SSL_CERT_FILE', 'SSL_CERT_DIR']
    .filter((key) => source[key]).map((key) => [key, source[key]]));
  return { ...inherited, AUTH0_DOMAIN: config.auth0Domain, AUTH0_CLIENT_ID: config.auth0ClientId,
    AUTH0_CLIENT_SECRET: config.auth0ClientSecret, TF_VAR_auth0_domain: config.auth0Domain,
    TF_IN_AUTOMATION: '1', TF_INPUT: '0', TF_LOG: 'off' };
}
function safeProviderEnvironment(source = process.env) {
  const inherited = Object.fromEntries(['PATH', 'HOME', 'TMPDIR', 'TEMP', 'TMP', 'SSL_CERT_FILE', 'SSL_CERT_DIR']
    .filter((key) => source[key]).map((key) => [key, source[key]]));
  return { ...inherited, TF_IN_AUTOMATION: '1', TF_INPUT: '0', TF_LOG: 'off' };
}
async function captureTerraform(args, { cwd, env, signal, spawnImpl = spawn }) {
  return await new Promise((resolve, reject) => {
    const child = spawnImpl('terraform', args, { cwd, env, signal, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let bytes = 0;
    let overflow = false;
    let spawnFailed = false;
    const collect = (chunk) => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > maxCapturedBytes) { overflow = true; child.kill('SIGTERM'); return; }
      out += chunk;
    };
    child.stdout.setEncoding('utf8').on('data', collect);
    child.stderr.setEncoding('utf8').on('data', () => {});
    child.once('error', () => { spawnFailed = true; });
    child.once('close', (code) => {
      if (spawnFailed) reject(new Error('Terraform read-only command could not be started.'));
      else if (overflow) reject(new Error('Terraform output exceeded the in-memory safety limit.'));
      else if (code !== 0) reject(new Error('Terraform read-only command failed; details were suppressed.'));
      else resolve(out);
    });
  });
}
function identityMatches(before, after) { return sameHcpIdentity(before, after); }

/** Adapter-driven fixed refresh-only workflow; no apply or state-write operation exists. */
export async function runRefreshOnlyPlan(deps = {}) {
  const { verifyHcp, loadConfiguration, runPlan, showPlan, runProviderSchema, getPinnedProviderVersion } = deps;
  if (![verifyHcp, loadConfiguration, runPlan, showPlan, runProviderSchema, getPinnedProviderVersion].every((fn) => typeof fn === 'function')) {
    throw new Error('Read-only reconciliation adapters are incomplete.');
  }
  const fs = deps.fs ?? {};
  const signal = deps.signal;
  const pinned = await getPinnedProviderVersion();
  if (pinned !== expectedProviderVersion) throw new Error('Pinned Auth0 provider version did not verify.');
  const stateBefore = await verifyHcp({ mode: 'reinit', terraformRoot: moduleDirectory });
  if (!identityMatches(stateBefore, stateBefore)) throw new Error('Verified HCP state identity is unavailable.');
  const config = await loadConfiguration();
  const directory = await createPrivateDirectory(fs);
  let summary;
  let operationError;
  try {
    if (signal?.aborted) throw new Error('cancelled');
    const context = { cwd: moduleDirectory, env: safeTerraformEnvironment(config, deps.env), signal };
    const schemaJson = await runProviderSchema({ ...context, env: safeProviderEnvironment(deps.env) });
    const afterSchema = await verifyHcp({ mode: 'reinit', terraformRoot: moduleDirectory });
    if (!identityMatches(stateBefore, afterSchema) || signal?.aborted) throw new Error('identity or cancellation');
    const planPath = path.join(directory, 'refresh-only.tfplan');
    await runPlan(planPath, context);
    const initialPlanStat = await (fs.lstatImpl ?? lstat)(planPath);
    if (!initialPlanStat.isFile() || initialPlanStat.isSymbolicLink()) throw new Error('plan file is not regular');
    await (fs.chmodImpl ?? chmod)(planPath, 0o600);
    const securedPlanStat = await (fs.lstatImpl ?? lstat)(planPath);
    if (!securedPlanStat.isFile() || securedPlanStat.isSymbolicLink() || (securedPlanStat.mode & 0o777) !== 0o600) throw new Error('plan mode');
    const afterPlan = await verifyHcp({ mode: 'reinit', terraformRoot: moduleDirectory });
    if (!identityMatches(stateBefore, afterPlan) || signal?.aborted) throw new Error('identity or cancellation');
    const json = await showPlan(planPath, context);
    const afterShow = await verifyHcp({ mode: 'reinit', terraformRoot: moduleDirectory });
    if (!identityMatches(stateBefore, afterShow) || signal?.aborted) throw new Error('identity or cancellation');
    let document;
    try { document = JSON.parse(json); } catch { throw new Error('invalid JSON'); }
    summary = validateRefreshOnlyPlan(document, schemaJson, pinned);
  } catch (error) { operationError = error; }
  let cleanupError;
  try { await removePrivateDirectory(directory, fs); } catch (error) { cleanupError = error; }
  if (cleanupError) throw cleanupError;
  if (operationError) throw new Error('Read-only refresh-only planning stopped safely; no plan details were emitted.');
  return summary;
}

export function createRefreshOnlyAdapters({ spawnImpl = spawn } = {}) {
  return {
    runPlan: async (planPath, context) => {
      await captureTerraform(['plan', '-refresh-only', '-input=false', '-no-color', '-lock=true', `-out=${planPath}`], { ...context, spawnImpl });
    },
    showPlan: async (planPath, context) => await captureTerraform(['show', '-json', planPath], { ...context, spawnImpl }),
    runProviderSchema: async (context) => await captureTerraform(['providers', 'schema', '-json'], { ...context, spawnImpl }),
  };
}
export function assertRefreshOnlyInvocation({ argv = process.argv, stdinIsTTY = stdin.isTTY, stdoutIsTTY = stdout.isTTY, env = process.env } = {}) {
  if (argv.length !== 2 || !stdinIsTTY || !stdoutIsTTY || isAutomatedContext(env)) {
    throw new Error('State reconciliation requires a direct interactive terminal and accepts no arguments.');
  }
}
async function confirmReadOnlyIntent() {
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    const answer = await rl.question(`This command creates only an unsent refresh-only plan; no state or Auth0 changes will be applied. Type exactly: ${refreshOnlyConfirmation}\n> `);
    if (answer !== refreshOnlyConfirmation) throw new Error('confirmation mismatch');
  } finally { rl.close(); }
}
async function readPinnedProviderVersion() {
  return parsePinnedAuth0ProviderVersion(await readFile(path.join(moduleDirectory, '.terraform.lock.hcl'), 'utf8'));
}
async function main() {
  assertRefreshOnlyInvocation();
  await confirmReadOnlyIntent();
  const originalUmask = process.umask(0o077);
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.once('SIGINT', abort);
  process.once('SIGTERM', abort);
  try {
    const loader = createLocalConfigurationLoader();
    const summary = await runRefreshOnlyPlan({
      verifyHcp: (options) => verifyHcpConfiguration({ ...options, home: os.homedir() }),
      loadConfiguration: () => loader(),
      getPinnedProviderVersion: readPinnedProviderVersion,
      ...createRefreshOnlyAdapters(),
      signal: controller.signal,
    });
    stdout.write(`${JSON.stringify(summary)}\n`);
  } finally {
    process.removeListener('SIGINT', abort);
    process.removeListener('SIGTERM', abort);
    process.umask(originalUmask);
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(() => { stdout.write('Read-only state reconciliation stopped safely; no plan or credential details were emitted.\n'); process.exitCode = 1; });
}

#!/usr/bin/env node
import { createHash, randomBytes } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { chmod, lstat, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { rootIdentity, verifyHcpConfiguration } from './hcp-preflight.mjs';

export const organizationName = 'aegis-ai-portfolio';
export const workspaceName = 'aegis-auth0-dev';
export const expectedResourceAddresses = Object.freeze([
  'auth0_resource_server.cases',
  'auth0_resource_server_scope.read_cases',
  'auth0_resource_server_scope.write_cases',
  'auth0_client.local_spa',
  'auth0_connection_client.local_spa_database',
]);

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(moduleDirectory, '../../..');
const terraformMetadataDirectory = path.join(moduleDirectory, '.terraform');
const environmentFile = path.join(repositoryRoot, '.env.auth0');
const terraformVariablesFile = path.join(moduleDirectory, 'terraform.tfvars');
const secretPattern = /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\beyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{8,}\b/;
const knownTopLevelPlanFields = new Set([
  'format_version', 'terraform_version', 'variables', 'planned_values', 'proposed_unknown',
  'resource_changes', 'resource_drift', 'output_changes', 'prior_state', 'configuration',
  'relevant_attributes', 'checks', 'errored', 'complete', 'applyable', 'deferred_changes',
  'action_invocations',
]);
const knownChangeFields = new Set([
  'address', 'module_address', 'mode', 'type', 'name', 'index', 'provider_name', 'change',
  'action_reason', 'previous_address', 'deposed', 'generated_config',
]);
const knownChangeBodyFields = new Set(['actions', 'before', 'after', 'after_unknown', 'before_sensitive', 'after_sensitive', 'replace_paths', 'importing']);

export function isAutomatedContext(env = process.env) {
  return Boolean(env.CI || env.GITHUB_ACTIONS || env.NODE_ENV === 'test' || env.VITEST || env.JEST_WORKER_ID ||
    Object.keys(env).some((key) => key.startsWith('CODEX_') || key.startsWith('OPENAI_CODEX')));
}

/** Strictly inspect the machine-readable plan without emitting any of its contents. */
export function validatePlanDocument(document) {
  if (!document || typeof document !== 'object' || Array.isArray(document) ||
      Object.keys(document).some((key) => !knownTopLevelPlanFields.has(key)) ||
      !['1.0', '1.1', '1.2'].includes(document.format_version) ||
      typeof document.terraform_version !== 'string' ||
      document.errored !== false || document.complete !== true || document.applyable !== true ||
      !Array.isArray(document.resource_changes) || !Array.isArray(document.resource_drift) ||
      document.resource_drift.length !== 0 ||
      (document.deferred_changes !== undefined && (!Array.isArray(document.deferred_changes) || document.deferred_changes.length !== 0)) ||
      (document.action_invocations !== undefined && (!Array.isArray(document.action_invocations) || document.action_invocations.length !== 0))) {
    throw new Error('Terraform plan structure is unsupported, incomplete, or contains drift. Stop for manual review.');
  }

  const changes = document.resource_changes;
  if (changes.length !== expectedResourceAddresses.length) {
    throw new Error('Terraform plan does not contain exactly the five approved resources.');
  }
  const byAddress = new Map();
  for (const item of changes) {
    if (!item || typeof item !== 'object' || Array.isArray(item) ||
        Object.keys(item).some((key) => !knownChangeFields.has(key)) ||
        typeof item.address !== 'string' || item.mode !== 'managed' ||
        typeof item.type !== 'string' || typeof item.name !== 'string' || item.address !== `${item.type}.${item.name}` ||
        item.module_address !== undefined || item.index !== undefined || item.previous_address !== undefined ||
        item.deposed !== undefined || item.action_reason !== undefined || item.generated_config !== undefined ||
        item.provider_name !== 'registry.terraform.io/auth0/auth0' ||
        !item.change || typeof item.change !== 'object' || Array.isArray(item.change) ||
        Object.keys(item.change).some((key) => !knownChangeBodyFields.has(key)) ||
        JSON.stringify(item.change.actions) !== '["create"]' || item.change.before !== null ||
        !item.change.after || typeof item.change.after !== 'object' || Array.isArray(item.change.after) ||
        item.change.importing !== undefined ||
        (item.change.replace_paths !== undefined && (!Array.isArray(item.change.replace_paths) || item.change.replace_paths.length !== 0))) {
      throw new Error('Terraform plan contains an unexpected resource action or unsupported field.');
    }
    byAddress.set(item.address, item);
  }
  if (byAddress.size !== expectedResourceAddresses.length ||
      expectedResourceAddresses.some((address) => !byAddress.has(address))) {
    throw new Error('Terraform plan resource addresses do not exactly match the approved Aegis Auth0 foundation.');
  }
  const outputChanges = document.output_changes ?? {};
  if (!outputChanges || typeof outputChanges !== 'object' || Array.isArray(outputChanges) ||
      Object.keys(outputChanges).length !== 3 ||
      Object.keys(outputChanges).some((name) => !['audience', 'issuer', 'spa_client_id'].includes(name)) ||
      Object.values(outputChanges).some((change) => !change || typeof change !== 'object' ||
        Object.keys(change).some((field) => !['actions', 'before', 'after', 'after_unknown', 'before_sensitive', 'after_sensitive'].includes(field)) ||
        JSON.stringify(change.actions) !== '["create"]' || change.before !== null)) {
    throw new Error('Terraform plan contains unexpected output changes.');
  }
  return Object.freeze({ creates: expectedResourceAddresses.length, updates: 0, deletes: 0, addresses: expectedResourceAddresses });
}

export function redactText(value, secrets = []) {
  let result = String(value ?? '');
  for (const secret of secrets) {
    if (typeof secret === 'string' && secret.length >= 4) result = result.split(secret).join('[REDACTED]');
  }
  return result.replace(secretPattern, '[REDACTED_SECRET]');
}

function parseEnvAuth0(text) {
  const result = {};
  for (const line of text.split(/\r?\n/)) {
    const match = /^(AUTH0_DOMAIN|AUTH0_CLIENT_ID|AUTH0_CLIENT_SECRET)=(.*)$/.exec(line);
    if (!match) continue;
    if (Object.hasOwn(result, match[1])) throw new Error(`.env.auth0 contains a duplicate ${match[1]} key.`);
    let value;
    try { value = JSON.parse(match[2]); } catch { value = match[2].replace(/^['"]|['"]$/g, ''); }
    result[match[1]] = value;
  }
  if (!result.AUTH0_DOMAIN || !result.AUTH0_CLIENT_ID || !result.AUTH0_CLIENT_SECRET ||
      /[\r\n/]/.test(result.AUTH0_DOMAIN) || !/^[A-Za-z0-9-]+\.[A-Za-z0-9.-]+$/.test(result.AUTH0_DOMAIN)) {
    throw new Error('.env.auth0 is incomplete or malformed. Run the protected credential setup helper.');
  }
  return result;
}

async function readCredentials(filePath) {
  let info;
  try { info = await lstat(filePath); } catch { throw new Error('.env.auth0 is missing or unreadable.'); }
  if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) !== 0) {
    throw new Error('.env.auth0 must be a regular file with mode 0600 or stricter.');
  }
  return parseEnvAuth0(await readFile(filePath, 'utf8'));
}

async function readTerraformInputs(filePath) {
  let info;
  try { info = await lstat(filePath); } catch { throw new Error('terraform.tfvars is missing; configure the reviewed development database connection.'); }
  if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) !== 0) {
    throw new Error('terraform.tfvars must be a regular file with mode 0600 or stricter.');
  }
  const text = await readFile(filePath, 'utf8');
  const readString = (name, fallback) => {
    const matches = [...text.matchAll(new RegExp(`^\\s*${name}\\s*=\\s*"([^"\\r\\n]*)"\\s*(?:#.*)?$`, 'gm'))];
    if (matches.length > 1) throw new Error(`terraform.tfvars contains duplicate ${name} values.`);
    return matches.length ? matches[0][1] : fallback;
  };
  const connectionId = readString('database_connection_id');
  const apiIdentifier = readString('api_identifier', 'https://aegis-ai.local/api');
  const spaName = readString('spa_name', 'Aegis AI Local SPA');
  if (!connectionId || !/^[A-Za-z0-9_-]+$/.test(connectionId) || !/^https:\/\/[^\s]+$/.test(apiIdentifier) || !spaName) {
    throw new Error('terraform.tfvars does not contain valid Aegis API, SPA, and database connection inputs.');
  }
  return { connectionId, apiIdentifier, spaName };
}

async function readHcpToken(home) {
  const filePath = path.join(home, '.terraform.d', 'credentials.tfrc.json');
  let info;
  try { info = await lstat(filePath); } catch { throw new Error('Protected HCP Terraform CLI credentials are unavailable.'); }
  if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) !== 0) {
    throw new Error('HCP Terraform CLI credentials must be a regular file with mode 0600 or stricter.');
  }
  let json;
  try { json = JSON.parse(await readFile(filePath, 'utf8')); } catch { throw new Error('HCP Terraform CLI credentials are malformed.'); }
  const token = json?.credentials?.['app.terraform.io']?.token;
  if (typeof token !== 'string' || !token) throw new Error('Protected HCP Terraform CLI credentials are incomplete.');
  return token;
}

async function verifyBootstrapMarker(metadataDirectory, metadata) {
  const markerPath = path.join(metadataDirectory, 'aegis-state-binding.json');
  let info;
  try { info = await lstat(markerPath); } catch { throw new Error('The protected empty-bootstrap ownership marker is missing.'); }
  if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) !== 0) {
    throw new Error('The local bootstrap ownership marker must be a regular file with mode 0600 or stricter.');
  }
  let marker;
  try { marker = JSON.parse(await readFile(markerPath, 'utf8')); } catch { throw new Error('The local bootstrap ownership marker is malformed.'); }
  const fields = ['schemaVersion', 'rootIdentity', 'organization', 'workspace', 'workspaceId', 'backendFingerprint', 'stateVersionId', 'serial', 'inventoryHash'];
  if (!marker || typeof marker !== 'object' || Array.isArray(marker) ||
      Object.keys(marker).length !== fields.length || Object.keys(marker).some((field) => !fields.includes(field)) ||
      marker.schemaVersion !== 1 || marker.rootIdentity !== rootIdentity || marker.organization !== organizationName ||
      marker.workspace !== workspaceName || marker.workspaceId !== metadata.workspaceId ||
      marker.backendFingerprint !== metadata.backendFingerprint || marker.stateVersionId !== null ||
      marker.serial !== 0 || marker.inventoryHash !== null) {
    throw new Error('The local ownership marker does not prove the exact empty HCP bootstrap and backend binding.');
  }
}

async function readAuth0Token(credentials, fetchImpl) {
  const response = await fetchImpl(`https://${credentials.AUTH0_DOMAIN}/oauth/token`, {
    method: 'POST', redirect: 'error', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ grant_type: 'client_credentials', client_id: credentials.AUTH0_CLIENT_ID,
      client_secret: credentials.AUTH0_CLIENT_SECRET, audience: `https://${credentials.AUTH0_DOMAIN}/api/v2/`,
      scope: 'read:connections read:clients read:resource_servers' }),
  });
  let body;
  try { body = await response.json(); } catch { throw new Error('Auth0 read-only preflight returned an invalid response.'); }
  if (!response.ok || typeof body.access_token !== 'string' || !body.access_token) {
    throw new Error('Auth0 read-only Management API access was denied; verify read permissions without changing them.');
  }
  return body.access_token;
}

export async function verifyAuth0Target({ credentials, connectionId, apiIdentifier, spaName, fetchImpl = fetch }) {
  const token = await readAuth0Token(credentials, fetchImpl);
  const get = async (url) => {
    const response = await fetchImpl(url, { method: 'GET', redirect: 'error', headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } });
    if (!response.ok) throw new Error('Auth0 read-only resource verification failed; check Management API read permissions.');
    try { return await response.json(); } catch { throw new Error('Auth0 returned an invalid resource response.'); }
  };
  const connection = await get(`https://${credentials.AUTH0_DOMAIN}/api/v2/connections/${encodeURIComponent(connectionId)}`);
  if (connection?.id !== connectionId || connection?.strategy !== 'auth0') {
    throw new Error('The configured database connection is not the expected Auth0 development database connection.');
  }
  const clientsResponse = await get(`https://${credentials.AUTH0_DOMAIN}/api/v2/clients?per_page=100&page=0&include_totals=true`);
  const serversResponse = await get(`https://${credentials.AUTH0_DOMAIN}/api/v2/resource-servers?per_page=100&page=0&include_totals=true`);
  const clients = clientsResponse?.clients;
  const servers = serversResponse?.resource_servers;
  if (!Array.isArray(clients) || !Number.isInteger(clientsResponse.total) || clientsResponse.total !== clients.length ||
      !Array.isArray(servers) || !Number.isInteger(serversResponse.total) || serversResponse.total !== servers.length) {
    throw new Error('Auth0 resource inventory is incomplete; uniqueness cannot be proven.');
  }
  if (servers.some((item) => item?.identifier === apiIdentifier) || clients.some((item) => item?.name === spaName)) {
    throw new Error('An Aegis target API or SPA already exists; stop for manual review rather than adopting it.');
  }
  return Object.freeze({ domain: credentials.AUTH0_DOMAIN, connectionId });
}

function secureEnvironment(env, credentials) {
  const result = {};
  for (const name of ['PATH', 'HOME', 'TMPDIR', 'TEMP', 'TMP', 'SSL_CERT_FILE', 'SSL_CERT_DIR']) {
    if (env[name]) result[name] = env[name];
  }
  Object.assign(result, credentials, { TF_VAR_auth0_domain: credentials.AUTH0_DOMAIN, TF_INPUT: '0', TF_LOG: 'off' });
  return result;
}

function runProcess(command, args, { cwd, env, secrets = [], spawnImpl = spawn, signal }) {
  return new Promise((resolve, reject) => {
    const child = spawnImpl(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    let settled = false;
    const onAbort = () => child.kill?.('SIGTERM');
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      callback(value);
    };
    if (signal?.aborted) onAbort();
    else signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout?.setEncoding?.('utf8');
    child.stderr?.setEncoding?.('utf8');
    child.stdout?.on('data', (chunk) => { out += chunk; });
    child.stderr?.on('data', (chunk) => { err += chunk; });
    child.once('error', () => finish(reject, new Error(`${command} could not be started.`)));
    child.once('close', (code) => finish(resolve, { code: code ?? 1, stdout: redactText(out, secrets), stderr: redactText(err, secrets) }));
  });
}

async function assertPrivateDirectory(directory) {
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0) {
    throw new Error('Terraform metadata directory must be a private regular directory.');
  }
}

async function ensureNoStalePlans(directory) {
  const entries = await readdir(directory);
  if (entries.some((name) => name.startsWith('.aegis-first-apply-'))) {
    throw new Error('A prior private deployment plan artifact exists. Inspect it manually and remove it only after review.');
  }
}

async function makePrivatePlanDirectory(parent, create = mkdtemp, remove = (directory) => rm(directory, { recursive: true, force: false })) {
  await assertPrivateDirectory(parent);
  await ensureNoStalePlans(parent);
  const directory = await create(path.join(parent, '.aegis-first-apply-'));
  try {
    await chmod(directory, 0o700);
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0) {
      throw new Error('Private Terraform plan directory permissions could not be verified.');
    }
    return directory;
  } catch (error) {
    try { await remove(directory); } catch {
      throw new Error('Private plan directory setup failed and cleanup was incomplete; inspect the stale artifact manually.');
    }
    throw error;
  }
}

async function verifyPlanFile(planPath) {
  const info = await lstat(planPath);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('Terraform did not create a regular saved plan file.');
  await chmod(planPath, 0o600);
  const secured = await lstat(planPath);
  if ((secured.mode & 0o077) !== 0 || secured.size === 0) throw new Error('Saved plan permissions or contents could not be verified.');
  return { size: secured.size, mtimeMs: secured.mtimeMs, inode: secured.ino,
    digest: createHash('sha256').update(await readFile(planPath)).digest('hex') };
}

async function verifyPlanUnchanged(planPath, expected) {
  const actual = await verifyPlanFile(planPath);
  if (actual.size !== expected.size || actual.mtimeMs !== expected.mtimeMs || actual.inode !== expected.inode || actual.digest !== expected.digest) {
    throw new Error('The reviewed Terraform plan changed before apply; no apply was started.');
  }
}

function requireSuccess(result, operation) {
  if (result.code !== 0) {
    if (result.stdout) stdout.write(`${result.stdout}\n`);
    if (result.stderr) stdout.write(`${result.stderr}\n`);
    throw new Error(`Terraform ${operation} failed. Do not retry automatically; inspect HCP state and the sanitized output first.`);
  }
}

async function askQuestion(prompt, input = stdin, output = stdout, signal) {
  const readline = createInterface({ input, output, terminal: true });
  const onAbort = () => readline.close();
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    if (signal?.aborted) throw new Error('Deployment gate cancelled by signal.');
    return await readline.question(prompt, signal ? { signal } : undefined);
  } finally {
    signal?.removeEventListener('abort', onAbort);
    readline.close();
  }
}

function ensureLiveTerminal({ argv = process.argv, input = stdin, output = stdout, env = process.env } = {}) {
  if (argv.length !== 2) throw new Error('This dedicated entrypoint accepts no command-line arguments.');
  if (!input.isTTY || !output.isTTY) throw new Error('A genuine interactive terminal is required. Run this command in the normal VS Code Terminal.');
  if (isAutomatedContext(env)) throw new Error('Automated, test, CI, and Codex environments cannot execute the live deployment gate.');
}

/** Dependency-injected orchestration for deterministic mocks. Never call with live dependencies in tests. */
export async function runFirstDeploymentGate({
  env = process.env, home = os.homedir(), cwd = moduleDirectory, credentialsPath = environmentFile,
  tfvarsPath = terraformVariablesFile, metadataDirectory = terraformMetadataDirectory,
  input = stdin, output = stdout, argv = process.argv, fetchImpl = fetch,
  preflight = (options) => verifyHcpConfiguration(options),
  targetCheck = verifyAuth0Target, terraform = (command, args, options) => runProcess(command, args, options),
  createPlanDirectory = mkdtemp, removePlanDirectory = (directory) => rm(directory, { recursive: true, force: false }),
  prompt, nonce = () => randomBytes(6).toString('hex'), signal,
} = {}) {
  ensureLiveTerminal({ argv, input, output, env });
  const checkAbort = () => { if (signal?.aborted) throw new Error('Deployment gate cancelled by signal.'); };
  checkAbort();
  const credentials = await readCredentials(credentialsPath);
  const terraformInputs = await readTerraformInputs(tfvarsPath);
  const { connectionId, apiIdentifier, spaName } = terraformInputs;
  const secrets = [credentials.AUTH0_CLIENT_SECRET];
  const hcpToken = await readHcpToken(home);
  secrets.push(hcpToken);
  const verifyBootstrap = async () => {
    const result = await preflight({ home, terraformRoot: cwd });
    if (result?.organization !== organizationName || result?.workspace !== workspaceName ||
        result?.plan !== 'free' || result?.executionMode !== 'local' || result?.autoApply !== false || result?.state !== 'empty-bootstrap' ||
        typeof result?.workspaceId !== 'string' || !/^[a-f0-9]{64}$/.test(result?.backendFingerprint ?? '')) {
      throw new Error('HCP preflight did not prove the exact empty Aegis development bootstrap; stop for manual review.');
    }
    await verifyBootstrapMarker(metadataDirectory, result);
    return result;
  };
  const originalUmask = process.umask(0o077);
  let planDirectory;
  try {
    const bootstrap = await verifyBootstrap();
    checkAbort();
    await targetCheck({ credentials, connectionId, apiIdentifier, spaName, fetchImpl });
    checkAbort();
    planDirectory = await makePrivatePlanDirectory(metadataDirectory, createPlanDirectory, removePlanDirectory);
    const planPath = path.join(planDirectory, 'plan.tfplan');
    const childEnv = secureEnvironment(env, credentials);
    const run = async (args) => {
      if (signal?.aborted) throw new Error('Deployment gate cancelled by signal.');
      return terraform('terraform', args, { cwd, env: childEnv, secrets, signal });
    };

    const planned = await run(['plan', '-input=false', '-no-color', `-out=${planPath}`]);
    if (planned.stdout) output.write(`${planned.stdout}\n`);
    if (planned.stderr) output.write(`${planned.stderr}\n`);
    requireSuccess(planned, 'plan');
    const planIdentity = await verifyPlanFile(planPath);

    const jsonResult = await run(['show', '-json', planPath]);
    requireSuccess(jsonResult, 'plan inspection');
    let planDocument;
    try { planDocument = JSON.parse(jsonResult.stdout); } catch { throw new Error('Terraform returned malformed plan JSON; stop for manual review.'); }
    validatePlanDocument(planDocument);
    if (planDocument.variables?.database_connection_id?.value !== connectionId ||
        planDocument.variables?.auth0_domain?.value !== credentials.AUTH0_DOMAIN ||
        planDocument.variables?.api_identifier?.value !== apiIdentifier ||
        planDocument.variables?.spa_name?.value !== spaName) {
      throw new Error('The plan inputs do not match the verified Auth0 domain and selected database connection.');
    }
    const humanResult = await run(['show', '-no-color', planPath]);
    requireSuccess(humanResult, 'human-readable plan review');
    output.write('\nFresh saved plan summary: 5 creates, 0 changes, 0 destroys.\n');
    output.write(`${humanResult.stdout}\n`);
    output.write('Review the complete sanitized plan above before authorizing this one-time development deployment.\n');

    const confirmation = `DEPLOY AEGIS AUTH0 TO ${organizationName}/${workspaceName} — 5 CREATES ${nonce()}`;
    const answer = await (prompt ?? ((message) => askQuestion(message, input, output, signal)))(`Type exactly "${confirmation}" to apply this saved plan: `);
    if (answer !== confirmation) {
      output.write('Confirmation did not match. No apply was started.\n');
      return { applied: false, reason: 'cancelled' };
    }

    const rechecked = await verifyBootstrap();
    checkAbort();
    if (rechecked.workspaceId !== bootstrap.workspaceId || rechecked.backendFingerprint !== bootstrap.backendFingerprint) {
      throw new Error('The verified HCP workspace or backend binding changed during confirmation; no apply was started.');
    }
    await targetCheck({ credentials, connectionId, apiIdentifier, spaName, fetchImpl });
    await verifyPlanUnchanged(planPath, planIdentity);
    const finalJson = await run(['show', '-json', planPath]);
    requireSuccess(finalJson, 'final saved plan inspection');
    let finalDocument;
    try { finalDocument = JSON.parse(finalJson.stdout); } catch { throw new Error('Final saved plan JSON is malformed; no apply was started.'); }
    validatePlanDocument(finalDocument);
    if (JSON.stringify(finalDocument) !== JSON.stringify(planDocument)) {
      throw new Error('The saved plan inspection changed after human review; no apply was started.');
    }

    const applied = await run(['apply', '-input=false', '-no-color', planPath]);
    if (applied.stdout) output.write(`${applied.stdout}\n`);
    if (applied.stderr) output.write(`${applied.stderr}\n`);
    requireSuccess(applied, 'apply');
    output.write('Terraform reported a successful apply. Stop for manual review of the HCP state inventory; do not retry or bind automatically.\n');
    output.write('After confirming the exact five-resource inventory, run the documented bind-reviewed-state procedure and then a read-only no-op plan.\n');
    return { applied: true, reason: 'success' };
  } finally {
    try {
      if (planDirectory) await removePlanDirectory(planDirectory);
    } finally {
      process.umask(originalUmask);
    }
  }
}

async function main() {
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.on('SIGINT', abort);
  process.on('SIGTERM', abort);
  try {
    const result = await runFirstDeploymentGate({ signal: controller.signal });
    if (!result.applied) process.exitCode = 2;
  } catch (error) {
    stdout.write(`${error instanceof Error ? error.message : 'First deployment gate failed closed.'}\n`);
    process.exitCode = 2;
  } finally {
    process.off('SIGINT', abort);
    process.off('SIGTERM', abort);
  }
}

if (isMainModule(process.argv[1], import.meta.url)) await main();

function isMainModule(argvPath, moduleUrl) {
  if (!argvPath) return false;
  try { return moduleUrl === pathToFileURL(realpathSync(path.resolve(argvPath))).href; }
  catch { return false; }
}

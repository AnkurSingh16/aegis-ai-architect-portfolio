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
export function isAutomatedContext(env = process.env) {
  return Boolean(env.CI || env.GITHUB_ACTIONS || env.NODE_ENV === 'test' || env.VITEST || env.JEST_WORKER_ID ||
    Object.keys(env).some((key) => key.startsWith('CODEX_') || key.startsWith('OPENAI_CODEX')));
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isRfc3339Timestamp(value) {
  if (typeof value !== 'string') return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-](\d{2}):(\d{2}))$/.exec(value);
  if (!match || !Number.isFinite(Date.parse(value))) return false;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, , offsetHourText, offsetMinuteText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const offsetHour = offsetHourText === undefined ? 0 : Number(offsetHourText);
  const offsetMinute = offsetMinuteText === undefined ? 0 : Number(offsetMinuteText);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
  return year > 0 && month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth &&
    hour <= 23 && minute <= 59 && second <= 59 && offsetHour <= 23 && offsetMinute <= 59;
}

function hasUnknownPath(value, pathParts) {
  let current = value;
  for (const part of pathParts) {
    if (!isRecord(current) || !Object.hasOwn(current, part)) return false;
    current = current[part];
  }
  return current === true;
}

function hasUnknownMarker(value) {
  if (value === true) return true;
  if (Array.isArray(value)) return value.some(hasUnknownMarker);
  if (isRecord(value)) return Object.values(value).some(hasUnknownMarker);
  return false;
}

function isUnknownMarkerTree(value) {
  if (typeof value === 'boolean') return true;
  if (Array.isArray(value)) return value.every(isUnknownMarkerTree);
  if (isRecord(value)) return Object.values(value).every(isUnknownMarkerTree);
  return false;
}

function assertKnownAttribute(change, name, expected, address) {
  const marker = change.after_unknown[name];
  if (!Object.hasOwn(change.after, name) || JSON.stringify(change.after[name]) !== JSON.stringify(expected) ||
      (marker !== undefined && !isUnknownMarkerTree(marker)) || hasUnknownMarker(marker)) {
    throw new Error(`Terraform planned an unexpected value for ${address}.${name}.`);
  }
}

function assertComputedAttribute(change, name, address) {
  if (!hasUnknownPath(change.after_unknown, [name]) ||
      (Object.hasOwn(change.after, name) && change.after[name] !== null)) {
    throw new Error(`Terraform did not identify ${address}.${name} as a computed unknown value.`);
  }
}

function assertOutputChange(change, name, expected, { computed = false } = {}) {
  if (!isRecord(change) || JSON.stringify(change.actions) !== '["create"]' || change.before !== null) {
    throw new Error(`Terraform planned an unexpected output change for ${name}.`);
  }
  if (computed) {
    if ((change.after !== null && change.after !== undefined) || change.after_unknown !== true) {
      throw new Error(`Terraform did not identify output ${name} as computed.`);
    }
  } else if (change.after !== expected ||
      (change.after_unknown !== undefined && change.after_unknown !== false)) {
    throw new Error(`Terraform planned an unexpected value for output ${name}.`);
  }
}

function validateConfigurationReferences(configuration) {
  const providerConfigs = configuration?.provider_config;
  const rootModule = configuration?.root_module;
  if (!isRecord(providerConfigs) || Object.keys(providerConfigs).length !== 1 ||
      !isRecord(rootModule) || !Array.isArray(rootModule.resources) ||
      rootModule.resources.length !== expectedResourceAddresses.length ||
      (rootModule.module_calls !== undefined && (!isRecord(rootModule.module_calls) || Object.keys(rootModule.module_calls).length !== 0))) {
    throw new Error('Terraform configuration does not contain exactly one provider and the five approved root resources.');
  }

  const [providerConfigKey] = Object.keys(providerConfigs);
  const providerConfig = providerConfigs[providerConfigKey];
  if (!providerConfigKey || !isRecord(providerConfig) || providerConfig.name !== 'auth0' ||
      providerConfig.full_name !== 'registry.terraform.io/auth0/auth0' || providerConfig.alias !== undefined ||
      providerConfig.module_address !== undefined || !isRecord(providerConfig.expressions) ||
      JSON.stringify(Object.keys(providerConfig.expressions).sort()) !== '["domain"]' ||
      !Array.isArray(providerConfig.expressions.domain?.references) ||
      providerConfig.expressions.domain.references.length !== 1 ||
      providerConfig.expressions.domain.references[0] !== 'var.auth0_domain') {
    throw new Error('Terraform provider configuration must be the single Auth0 provider using only the approved domain input.');
  }

  const resources = new Map();
  for (const resource of rootModule.resources) {
    if (!isRecord(resource) || typeof resource.address !== 'string' || resource.mode !== 'managed' ||
        typeof resource.type !== 'string' || typeof resource.name !== 'string' ||
        resource.address !== `${resource.type}.${resource.name}` || resource.count_expression !== undefined ||
        resource.for_each_expression !== undefined || resource.provider_config_key !== providerConfigKey ||
        !isRecord(resource.expressions) || resources.has(resource.address)) {
      throw new Error('Terraform configuration has an unexpected resource or dynamic instance expression.');
    }
    resources.set(resource.address, resource);
  }
  if (expectedResourceAddresses.some((address) => !resources.has(address))) {
    throw new Error('Terraform configuration resource addresses do not exactly match the approved Aegis resources.');
  }

  const expectedExpressionKeys = new Map([
    ['auth0_resource_server.cases', ['enforce_policies', 'identifier', 'name', 'signing_alg']],
    ['auth0_resource_server_scope.read_cases', ['description', 'resource_server_identifier', 'scope']],
    ['auth0_resource_server_scope.write_cases', ['description', 'resource_server_identifier', 'scope']],
    ['auth0_client.local_spa', ['allowed_logout_urls', 'allowed_origins', 'app_type', 'callbacks', 'grant_types', 'is_first_party', 'name', 'oidc_conformant', 'web_origins']],
    ['auth0_connection_client.local_spa_database', ['client_id', 'connection_id']],
  ]);
  for (const [address, expectedKeys] of expectedExpressionKeys) {
    const resource = resources.get(address);
    if (JSON.stringify(Object.keys(resource.expressions).sort()) !== JSON.stringify(expectedKeys) ||
        (resource.provisioners !== undefined && (!Array.isArray(resource.provisioners) || resource.provisioners.length !== 0))) {
      throw new Error(`Terraform configuration contains unapproved arguments or provisioners for ${address}.`);
    }
  }

  const association = resources.get('auth0_connection_client.local_spa_database').expressions;
  const connectionExpression = association.connection_id;
  const clientExpression = association.client_id;
  const exactReferences = (expression, expected) => isRecord(expression) && Array.isArray(expression.references) &&
    expression.references.length === expected.length && expected.every((reference) => expression.references.includes(reference));
  if (!exactReferences(connectionExpression, ['var.database_connection_id']) ||
      !exactReferences(clientExpression, ['auth0_client.local_spa.id', 'auth0_client.local_spa'])) {
    throw new Error('Terraform configuration does not associate the approved database connection with the approved SPA.');
  }
}

/** Inspect Terraform plan JSON in memory without emitting its contents. */
export function validatePlanDocument(document, expectedInputs) {
  const version = typeof document?.format_version === 'string' ? /^(\d+)\.(\d+)$/.exec(document.format_version) : null;
  const drift = document?.resource_drift;
  if (!isRecord(document) || !version || Number(version[1]) !== 1 ||
      typeof document.terraform_version !== 'string' ||
      (document.timestamp !== undefined && !isRfc3339Timestamp(document.timestamp)) ||
      document.errored !== false || document.complete !== true || document.applyable !== true ||
      !Array.isArray(document.resource_changes) ||
      (drift !== undefined && (!Array.isArray(drift) || drift.length !== 0)) ||
      (document.deferred_changes !== undefined && (!Array.isArray(document.deferred_changes) || document.deferred_changes.length !== 0)) ||
      (document.action_invocations !== undefined && (!Array.isArray(document.action_invocations) || document.action_invocations.length !== 0))) {
    throw new Error('Terraform plan structure is unsupported, incomplete, or contains drift. Stop for manual review.');
  }
  validateConfigurationReferences(document.configuration);

  const changes = document.resource_changes;
  if (changes.length !== expectedResourceAddresses.length) {
    throw new Error('Terraform plan does not contain exactly the five approved resources.');
  }
  const byAddress = new Map();
  for (const item of changes) {
    if (!isRecord(item) ||
        typeof item.address !== 'string' || item.mode !== 'managed' ||
        typeof item.type !== 'string' || typeof item.name !== 'string' || item.address !== `${item.type}.${item.name}` ||
        item.module_address !== undefined || item.index !== undefined || item.previous_address !== undefined ||
        item.deposed !== undefined || item.generated_config !== undefined ||
        (item.action_reason !== undefined && typeof item.action_reason !== 'string') ||
        item.provider_name !== 'registry.terraform.io/auth0/auth0' ||
        !isRecord(item.change) ||
        JSON.stringify(item.change.actions) !== '["create"]' || item.change.before !== null ||
        !isRecord(item.change.after) || !isRecord(item.change.after_unknown) ||
        !isUnknownMarkerTree(item.change.after_unknown) ||
        item.change.importing !== undefined ||
        (item.change.replace_paths !== undefined && (!Array.isArray(item.change.replace_paths) || item.change.replace_paths.length !== 0))) {
      throw new Error('Terraform plan contains an unexpected resource action or unsupported field.');
    }
    if (byAddress.has(item.address)) throw new Error('Terraform plan contains duplicate resource addresses.');
    byAddress.set(item.address, item);
  }
  if (expectedResourceAddresses.some((address) => !byAddress.has(address))) {
    throw new Error('Terraform plan resource addresses do not exactly match the approved Aegis Auth0 foundation.');
  }

  if (!isRecord(expectedInputs) || [expectedInputs.connectionId, expectedInputs.apiIdentifier, expectedInputs.spaName, expectedInputs.auth0Domain]
    .some((value) => typeof value !== 'string' || !value)) {
    throw new Error('Approved Terraform target inputs are incomplete.');
  }
  const { connectionId, apiIdentifier, spaName, auth0Domain } = expectedInputs;
  const expectedAttributes = new Map([
    ['auth0_resource_server.cases', {
      name: 'Aegis Case API', identifier: apiIdentifier, signing_alg: 'RS256', enforce_policies: false,
    }],
    ['auth0_resource_server_scope.read_cases', {
      scope: 'read:cases', resource_server_identifier: apiIdentifier,
      description: 'Read cases for an authorized tenant membership.',
    }],
    ['auth0_resource_server_scope.write_cases', {
      scope: 'write:cases', resource_server_identifier: apiIdentifier,
      description: 'Create and update cases for an authorized tenant membership.',
    }],
    ['auth0_client.local_spa', {
      name: spaName, app_type: 'spa', oidc_conformant: true, is_first_party: true,
      grant_types: ['authorization_code'],
      callbacks: ['http://127.0.0.1:49321/auth/callback'],
      allowed_origins: ['http://127.0.0.1:49321'],
      web_origins: ['http://127.0.0.1:49321'],
      allowed_logout_urls: ['http://127.0.0.1:49321'],
    }],
    ['auth0_connection_client.local_spa_database', { connection_id: connectionId }],
  ]);
  for (const [address, attributes] of expectedAttributes) {
    const change = byAddress.get(address).change;
    for (const [name, value] of Object.entries(attributes)) assertKnownAttribute(change, name, value, address);
  }
  assertComputedAttribute(byAddress.get('auth0_client.local_spa').change, 'id', 'auth0_client.local_spa');
  assertComputedAttribute(byAddress.get('auth0_connection_client.local_spa_database').change, 'client_id', 'auth0_connection_client.local_spa_database');

  const outputChanges = document.output_changes;
  if (!isRecord(outputChanges) ||
      Object.keys(outputChanges).length !== 3 ||
      Object.keys(outputChanges).some((name) => !['audience', 'issuer', 'spa_client_id'].includes(name))) {
    throw new Error('Terraform plan contains unexpected output changes.');
  }
  assertOutputChange(outputChanges.audience, 'audience', apiIdentifier);
  assertOutputChange(outputChanges.issuer, 'issuer', `https://${auth0Domain}/`);
  assertOutputChange(outputChanges.spa_client_id, 'spa_client_id', undefined, { computed: true });
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
    validatePlanDocument(planDocument, { connectionId, apiIdentifier, spaName, auth0Domain: credentials.AUTH0_DOMAIN });
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
    validatePlanDocument(finalDocument, { connectionId, apiIdentifier, spaName, auth0Domain: credentials.AUTH0_DOMAIN });
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

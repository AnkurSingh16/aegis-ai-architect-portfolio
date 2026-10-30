#!/usr/bin/env node
import { chmod, lstat, mkdir, open, readFile, rename, stat, unlink } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createBindingMarker, verifyHcpConfiguration } from './hcp-preflight.mjs';

const directory = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(directory, '../../..');
const credentialPath = path.join(root, '.env.auth0');
const terraformDirectory = path.join(directory, '.terraform');
const backendMetadataPath = path.join(terraformDirectory, 'terraform.tfstate');
const markerPath = path.join(terraformDirectory, 'aegis-state-binding.json');
process.umask(0o077);

const operations = {
  fmt: ['fmt', '-check', '-recursive'],
  init: ['init', '-input=false', '-no-color'],
  validate: ['validate', '-no-color'],
  plan: ['plan', '-input=false', '-no-color'],
};
const action = process.argv[2];
if (action === 'bind-reviewed-state') {
  if (process.argv.length !== 3) usage();
  await bindReviewedState();
} else if (!Object.hasOwn(operations, action) || process.argv.length !== 3) {
  usage();
} else {
  await runTerraform(action);
}

async function runTerraform(operation) {
  if (operation === 'init' || operation === 'plan') {
    try {
      const metadata = await verifyHcpConfiguration({ terraformRoot: root });
      console.log(`HCP preflight passed: ${JSON.stringify({ organization: metadata.organization, workspace: metadata.workspace, state: metadata.state })}`);
    } catch (error) {
      console.error(error instanceof Error ? error.message : 'HCP Terraform preflight failed.');
      process.exitCode = 2;
      return;
    }
  }

  let credentials = {};
  if (operation === 'plan') {
    try {
      credentials = parseCredentials(await readFile(credentialPath, 'utf8'));
    } catch {
      console.error('Cannot read .env.auth0. Run node scripts/setup-auth0-env.mjs in an interactive terminal first.');
      process.exitCode = 2;
      return;
    }
  }

  const env = {};
  for (const name of ['PATH', 'HOME', 'TMPDIR', 'TEMP', 'TMP', 'SSL_CERT_FILE', 'SSL_CERT_DIR']) {
    if (process.env[name]) env[name] = process.env[name];
  }
  Object.assign(env, credentials, {
    ...(credentials.AUTH0_DOMAIN ? { TF_VAR_auth0_domain: credentials.AUTH0_DOMAIN } : {}),
    TF_IN_AUTOMATION: '1', TF_INPUT: '0', TF_LOG: 'off',
  });

  const [command, ...args] = operations[operation];
  const result = await executeTerraform(command, args, env, credentials.AUTH0_CLIENT_SECRET);
  let resultCode = result.code;
  if (operation === 'init' && resultCode === 0) {
    try {
      await secureBackendMetadata();
      const metadata = await verifyHcpConfiguration({ terraformRoot: root });
      if (metadata.state === 'empty-bootstrap') await writeBootstrapMarker(metadata);
    } catch (error) {
      resultCode = 1;
      result.stderr += `${error instanceof Error ? error.message : 'Could not verify initialized remote state.'}\n`;
    }
  }
  if (result.stdout) process.stdout.write(redact(result.stdout, credentials.AUTH0_CLIENT_SECRET));
  if (result.stderr) process.stderr.write(redact(result.stderr, credentials.AUTH0_CLIENT_SECRET));
  process.exitCode = resultCode;
}

async function executeTerraform(command, args, env, secret) {
  return new Promise((resolve) => {
    const child = spawn('terraform', [command, ...args], { cwd: directory, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => { out += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk) => { err += chunk; });
    child.on('error', (error) => resolve({ code: 127, stdout: '', stderr: error.code === 'ENOENT' ? 'Terraform CLI not found. Install Terraform 1.9 or newer.' : 'Terraform could not be started.' }));
    child.on('close', (code) => resolve({ code: code ?? 1, stdout: out, stderr: err }));
  }).then((result) => ({ ...result, stdout: redact(result.stdout, secret), stderr: redact(result.stderr, secret) }));
}

async function secureBackendMetadata() {
  const info = await lstat(backendMetadataPath);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('Terraform backend metadata is not a regular file.');
  await chmod(backendMetadataPath, 0o600);
  if ((await stat(backendMetadataPath)).mode & 0o077) throw new Error('Terraform backend metadata permissions remain too broad.');
}

async function writeBootstrapMarker(metadata) {
  let existing;
  try {
    const info = await lstat(markerPath);
    if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) !== 0) throw new Error('unsafe');
    existing = JSON.parse(await readFile(markerPath, 'utf8'));
  } catch (error) {
    if (error?.code !== 'ENOENT') throw new Error('Existing local state ownership marker is unsafe or malformed; manual review is required.');
  }
  const allowedKeys = ['schemaVersion', 'rootIdentity', 'organization', 'workspace', 'workspaceId', 'backendFingerprint', 'stateVersionId', 'serial', 'inventoryHash'];
  if (existing && (existing.rootIdentity !== 'aegis-ai-portfolio/infra/terraform/auth0:v1' ||
      Object.keys(existing).length !== allowedKeys.length || Object.keys(existing).some((key) => !allowedKeys.includes(key)) ||
      existing.schemaVersion !== 1 ||
      existing.organization !== metadata.organization || existing.workspace !== metadata.workspace ||
      existing.workspaceId !== metadata.workspaceId || existing.backendFingerprint !== metadata.backendFingerprint ||
      existing.stateVersionId !== null || existing.serial !== 0 || existing.inventoryHash !== null)) {
    throw new Error('Existing local state ownership marker does not match an empty bootstrap; manual review is required.');
  }
  if (!existing) await atomicWriteMarker(createBindingMarker({ ...metadata, stateVersionId: null, serial: 0, inventoryHash: null }));
}

async function bindReviewedState() {
  if (!stdin.isTTY || !stdout.isTTY) {
    console.error('bind-reviewed-state requires an interactive terminal. Run it in the normal VS Code Terminal after reviewing the HCP state version.');
    process.exitCode = 2;
    return;
  }
  let metadata;
  try {
    metadata = await verifyHcpConfiguration({ terraformRoot: root, mode: 'bind' });
    if (metadata.state !== 'reviewable-managed-state') throw new Error('The HCP workspace does not contain a reviewable managed state version.');
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'HCP state could not be reviewed.');
    process.exitCode = 2;
    return;
  }
  console.log(`Workspace: ${metadata.workspace}`);
  console.log(`Current state version: ${metadata.stateVersionId}`);
  console.log(`Serial: ${metadata.serial}`);
  console.log('Inventory: the exact five expected Aegis Auth0 resources and provider were verified.');
  const expected = `bind ${metadata.workspace} ${metadata.stateVersionId}`;
  const readline = createInterface({ input: stdin, output: stdout });
  let answer;
  try { answer = await readline.question(`Type exactly "${expected}" to bind this reviewed version: `); }
  finally { readline.close(); }
  if (answer !== expected) {
    console.error('Confirmation did not match; no local binding marker was changed.');
    process.exitCode = 2;
    return;
  }
  try {
    await atomicWriteMarker(createBindingMarker(metadata), { allowUpdate: true });
    console.log('Local state ownership marker updated. No Terraform command or HCP write was performed.');
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Could not update the local ownership marker.');
    process.exitCode = 1;
  }
}

async function atomicWriteMarker(marker, { allowUpdate = false } = {}) {
  await mkdir(terraformDirectory, { recursive: true, mode: 0o700 });
  const tempPath = path.join(terraformDirectory, `.aegis-state-binding-${process.pid}-${Date.now()}.tmp`);
  let handle;
  try {
    handle = await open(tempPath, 'wx', 0o600);
    await handle.writeFile(`${JSON.stringify(marker, null, 2)}\n`, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    try {
      const existing = await lstat(markerPath);
      if (!allowUpdate) throw new Error('Local ownership marker already exists; refusing to overwrite it.');
      if (!existing.isFile() || existing.isSymbolicLink() || (existing.mode & 0o077) !== 0) throw new Error('Existing local ownership marker is unsafe.');
      const parsed = JSON.parse(await readFile(markerPath, 'utf8'));
      if (parsed?.schemaVersion !== 1 || parsed?.rootIdentity !== marker.rootIdentity || parsed?.organization !== marker.organization ||
          parsed?.workspace !== marker.workspace || parsed?.workspaceId !== marker.workspaceId || parsed?.backendFingerprint !== marker.backendFingerprint) {
        throw new Error('Existing ownership marker is bound to another root or workspace; manual review is required.');
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    await rename(tempPath, markerPath);
    await chmod(markerPath, 0o600);
    if ((await stat(markerPath)).mode & 0o077) throw new Error('Local ownership marker permissions remain too broad.');
  } finally {
    if (handle) await handle.close().catch(() => {});
    await unlink(tempPath).catch(() => {});
  }
}

function parseCredentials(contents) {
  const parsed = {};
  for (const line of contents.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const match = /^(AUTH0_DOMAIN|AUTH0_CLIENT_ID|AUTH0_CLIENT_SECRET)=(.+)$/.exec(line);
    if (!match) throw new Error('invalid credentials file');
    if (Object.hasOwn(parsed, match[1])) throw new Error('duplicate credentials entry');
    parsed[match[1]] = JSON.parse(match[2]);
  }
  for (const key of ['AUTH0_DOMAIN', 'AUTH0_CLIENT_ID', 'AUTH0_CLIENT_SECRET']) {
    if (typeof parsed[key] !== 'string' || !parsed[key]) throw new Error('invalid credentials file');
  }
  if (Object.keys(parsed).length !== 3) throw new Error('invalid credentials file');
  return parsed;
}

function redact(value, secret) { return secret ? value.split(secret).join('[REDACTED]') : value; }
function usage() {
  console.error('Usage: node infra/terraform/auth0/terraform-local.mjs <fmt|init|validate|plan|bind-reviewed-state>');
  console.error('Apply, destroy, import, state commands, and arbitrary Terraform arguments are unavailable.');
  process.exit(2);
}

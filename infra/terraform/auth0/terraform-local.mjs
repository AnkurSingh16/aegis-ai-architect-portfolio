#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const directory = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(directory, '../../..');
const credentialPath = path.join(root, '.env.auth0');
const operations = {
  fmt: ['fmt', '-check', '-recursive'],
  init: ['init', '-backend=false', '-input=false', '-no-color'],
  validate: ['validate', '-no-color'],
  plan: ['plan', '-input=false', '-no-color'],
};
const action = process.argv[2];

if (!Object.hasOwn(operations, action) || process.argv.length !== 3) {
  console.error('Usage: node infra/terraform/auth0/terraform-local.mjs <fmt|init|validate|plan>');
  console.error('Apply, destroy, import, and state commands are intentionally unavailable.');
  process.exit(2);
}

let credentials = {};
if (action === 'plan') {
  try {
    credentials = parseCredentials(await readFile(credentialPath, 'utf8'));
  } catch {
    console.error('Cannot read .env.auth0. Run node scripts/setup-auth0-env.mjs in an interactive terminal first.');
    process.exit(2);
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

const [command, ...args] = operations[action];
const result = await new Promise((resolve) => {
  const child = spawn('terraform', [command, ...args], { cwd: directory, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
  child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
  child.on('error', (error) => resolve({ code: 127, stderr: error.code === 'ENOENT' ? 'Terraform CLI not found. Install Terraform 1.9 or newer.' : 'Terraform could not be started.' }));
  child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
});

for (const output of [result.stdout, result.stderr]) {
  if (output) process.stdout.write(redact(output, credentials.AUTH0_CLIENT_SECRET));
}
process.exitCode = result.code;

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

function redact(value, secret) {
  return secret ? value.split(secret).join('[REDACTED]') : value;
}

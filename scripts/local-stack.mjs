#!/usr/bin/env node
// Local AEGIS stack lifecycle. Commands: init | up | status | verify | down.
// Safety rules enforced here: secrets are generated locally and never printed; `init` never overwrites an existing .env.local;
// `down` never removes volumes; every command targets only the compose project "aegis-local".
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const envFile = join(root, '.env.local');
const project = 'aegis-local';
const command = process.argv[2];

function readEnv(path) {
  const values = {};
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const match = /^([A-Z_]+)=(.*)$/.exec(line.trim());
    if (match) values[match[1]] = match[2];
  }
  return values;
}

function compose(args, options = {}) {
  const result = spawnSync('docker', ['compose', '-p', project, '--env-file', envFile, ...args], {
    cwd: root, stdio: options.capture ? 'pipe' : 'inherit', encoding: 'utf8',
  });
  return result;
}

// Generated secrets and their defaults. `init` adds a missing entry and never changes an existing one.
const GENERATED = ['AEGIS_DB_ADMIN_PASSWORD', 'AEGIS_DB_APP_PASSWORD', 'AEGIS_DB_INGEST_PASSWORD',
  'AEGIS_KEYCLOAK_DB_PASSWORD', 'AEGIS_KEYCLOAK_ADMIN_PASSWORD', 'AEGIS_KC_TEST_CLIENT_SECRET',
  'AEGIS_KC_SHORT_CLIENT_SECRET', 'AEGIS_KC_TEST_USER_PASSWORD'];
const DEFAULTS = { AEGIS_PORT_POSTGRES: '55432', AEGIS_PORT_API: '4110', AEGIS_PORT_WEB: '5190', AEGIS_PORT_KEYCLOAK: '8180' };

function init() {
  const existing = existsSync(envFile) ? readEnv(envFile) : {};
  const lines = existsSync(envFile) ? readFileSync(envFile, 'utf8').replace(/\n*$/, '\n').split('\n') : ['# Generated locally by scripts/local-stack.mjs. Do not commit. Do not share.'];
  const added = [];
  for (const key of GENERATED) {
    if (existing[key] === undefined) { lines.push(`${key}=${randomBytes(32).toString('hex')}`); added.push(key); }
  }
  for (const [key, value] of Object.entries(DEFAULTS)) {
    if (existing[key] === undefined) { lines.push(`${key}=${value}`); added.push(key); }
  }
  writeFileSync(envFile, lines.join('\n').replace(/\n*$/, '\n'), { mode: 0o600 });
  chmodSync(envFile, 0o600);
  console.log(added.length === 0 ? '.env.local is complete. Nothing changed.' : `.env.local: added ${added.length} entries (values not shown).`);
  return 0;
}

function requireEnv() {
  if (!existsSync(envFile)) {
    console.error('Run: node scripts/local-stack.mjs init');
    process.exit(2);
  }
  return readEnv(envFile);
}

function up() {
  requireEnv();
  const result = compose(['up', '-d', '--build', '--wait']);
  return result.status ?? 1;
}

function down() {
  requireEnv();
  // Deliberately no --volumes: persistent data is never removed by this script.
  const result = compose(['down']);
  return result.status ?? 1;
}

function status() {
  requireEnv();
  return compose(['ps']).status ?? 1;
}

async function check(label, url, expectStatus, predicate = () => true) {
  try {
    const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(5000) });
    const body = await response.text();
    const ok = response.status === expectStatus && predicate(body);
    console.log(`${ok ? 'PASS' : 'FAIL'} ${label} -> ${response.status}`);
    return ok;
  } catch {
    console.log(`FAIL ${label} -> unreachable`);
    return false;
  }
}

async function verify() {
  const env = requireEnv();
  const api = `http://127.0.0.1:${env.AEGIS_PORT_API ?? 4110}`;
  const web = `http://127.0.0.1:${env.AEGIS_PORT_WEB ?? 5190}`;
  const results = [
    await check('API liveness', `${api}/api/health`, 200, (b) => JSON.parse(b).ok === true),
    await check('API readiness (database and migrations)', `${api}/api/ready`, 200, (b) => JSON.parse(b).ready === true),
    await check('web application shell', `${web}/`, 200, (b) => b.includes('<div id="root"')),
    await check('web proxy to API liveness', `${web}/api/health`, 200, (b) => JSON.parse(b).ok === true),
    await check('web proxy to API readiness (database path)', `${web}/api/ready`, 200, (b) => JSON.parse(b).ready === true),
    await check('protected route refuses anonymous caller', `${api}/api/tenants/10000000-0000-4000-8000-000000000001/cases`, 401),
  ];
  const passed = results.every(Boolean);
  console.log(passed ? 'All local checks passed.' : 'One or more local checks failed.');
  return passed ? 0 : 1;
}

// Recovery drill: stops only this project's PostgreSQL, checks readiness and liveness while it is down, starts it again, restarts the
// API, and checks that both recover. It never removes containers or volumes.
async function drill() {
  const env = requireEnv();
  const api = `http://127.0.0.1:${env.AEGIS_PORT_API ?? 4110}`;
  const web = `http://127.0.0.1:${env.AEGIS_PORT_WEB ?? 5190}`;
  const steps = [];
  const step = (ok, label) => { steps.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`); };
  step(await check('baseline readiness', `${api}/api/ready`, 200), 'baseline readiness');
  compose(['stop', 'postgres']);
  step(await check('database down: readiness is 503', `${api}/api/ready`, 503, (b) => JSON.parse(b).reason === 'database_unavailable'), 'database down: readiness reports unavailable');
  step(await check('database down: liveness still 200', `${api}/api/health`, 200), 'database down: liveness unaffected');
  step(await check('database down: web proxy readiness 503', `${web}/api/ready`, 503), 'database down: proxy reports unavailable');
  compose(['start', 'postgres']);
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (await check('database recovering: readiness', `${api}/api/ready`, 200).catch(() => false)) break;
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  compose(['restart', 'api']);
  let recovered = false;
  for (let attempt = 0; attempt < 30 && !recovered; attempt += 1) {
    recovered = await fetch(`${api}/api/ready`, { signal: AbortSignal.timeout(3000) }).then((r) => r.status === 200).catch(() => false);
    if (!recovered) await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  step(recovered, 'after database and API restart: readiness is 200 again');
  const passed = steps.every(Boolean);
  console.log(passed ? 'Recovery drill passed.' : 'Recovery drill failed.');
  return passed ? 0 : 1;
}

const commands = { init, up, down, status, verify, drill };
if (!commands[command]) {
  console.error('Usage: node scripts/local-stack.mjs init | up | status | verify | drill | down');
  process.exit(2);
}
const code = await commands[command]();
process.exit(code ?? 0);

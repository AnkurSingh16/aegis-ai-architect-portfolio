#!/usr/bin/env node
// Measures the security-versus-availability behaviour of the signing-key policy (docs/KEY-ROTATION-POLICY.md, section 4).
// It stops the identity provider, observes how long a previously valid token is still accepted by the API, then restarts the identity
// provider and observes recovery. It also confirms that unauthenticated and non-identity endpoints remain available.
// Only the local compose project "aegis-local" is touched. Secrets are read from .env.local and never printed.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const env = Object.fromEntries(readFileSync(join(root, '.env.local'), 'utf8').split('\n')
  .map((line) => /^([A-Z0-9_]+)=(.*)$/.exec(line.trim())).filter(Boolean).map((m) => [m[1], m[2]]));
const KC = `http://127.0.0.1:${env.AEGIS_PORT_KEYCLOAK ?? 8180}/realms/aegis`;
const API = `http://127.0.0.1:${env.AEGIS_PORT_API ?? 4110}`;
const NORTH = '10000000-0000-4000-8000-000000000001';
const compose = (args) => execFileSync('docker', ['compose', '-p', 'aegis-local', '--env-file', join(root, '.env.local'), ...args],
  { cwd: root, encoding: 'utf8' });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const results = [];
const check = (label, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail ? ` (${detail})` : ''}`); };

async function token() {
  const body = new URLSearchParams({ grant_type: 'password', client_id: 'aegis-test-client', client_secret: env.AEGIS_KC_TEST_CLIENT_SECRET,
    username: 'alice.north', password: env.AEGIS_KC_TEST_USER_PASSWORD, scope: 'openid read:cases' });
  return (await (await fetch(`${KC}/protocol/openid-connect/token`, { method: 'POST', body })).json()).access_token;
}
async function status(url, bearer) {
  try {
    return (await fetch(url, { headers: bearer ? { authorization: `Bearer ${bearer}` } : {}, signal: AbortSignal.timeout(5000) })).status;
  } catch { return 0; }
}
const cases = (bearer) => status(`${API}/api/tenants/${NORTH}/cases`, bearer);

async function main() {
  const held = await token();
  check('token obtained before the outage is accepted', (await cases(held)) === 200);

  // Warm the key set: a successful verification ensures the API holds a cached set fetched shortly before the outage.
  compose(['stop', 'keycloak']);
  const stoppedAt = Date.now();
  let refusedAfter = null;
  const samples = [];
  while (Date.now() - stoppedAt < 110_000) {
    await sleep(5000);
    const s = await cases(held);
    samples.push(s);
    if (s === 401 && refusedAfter === null) refusedAfter = Math.round((Date.now() - stoppedAt) / 1000);
  }
  const acceptedBeforeRefusal = samples.filter((s) => s === 200).length;
  check('with the identity provider down, a held token is accepted only until the key-set cache expires',
    refusedAfter !== null && refusedAfter <= 80, refusedAfter === null ? 'never refused' : `first refused after ${refusedAfter}s`);
  console.log(`INFO accepted ${acceptedBeforeRefusal} of ${samples.length} samples during the outage window`);
  check('after expiry the API fails closed (no further acceptance)', samples.slice(-5).every((s) => s === 401));
  check('unauthenticated endpoints stay available during the outage', (await status(`${API}/api/health`)) === 200
    && (await status(`${API}/api/ready`)) === 200);
  check('an anonymous protected request is refused, not served', (await cases()) === 401);

  compose(['start', 'keycloak']);
  const restartedAt = Date.now();
  for (let i = 0; i < 90; i += 1) {
    const healthy = execFileSync('docker', ['inspect', '-f', '{{.State.Health.Status}}', 'aegis-local-keycloak-1'], { encoding: 'utf8' }).trim();
    if (healthy === 'healthy') break;
    await sleep(2000);
  }
  const fresh = await token();
  let recoveredAt = null;
  for (let i = 0; i < 60 && recoveredAt === null; i += 1) {
    if ((await cases(fresh)) === 200) recoveredAt = Math.round((Date.now() - restartedAt) / 1000);
    else await sleep(2000);
  }
  check('after the identity provider returns, a new token is accepted again', recoveredAt !== null,
    recoveredAt === null ? 'not recovered' : `recovered ${recoveredAt}s after restart`);
  const passed = results.every(Boolean);
  console.log(passed ? 'Availability policy check passed.' : 'Availability policy check failed.');
  return passed ? 0 : 1;
}

process.exit(await main());

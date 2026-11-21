#!/usr/bin/env node
// Telemetry acceptance for the local stack. It drives real requests (authorised, forbidden, anonymous) through the API, then reads what the
// OpenTelemetry Collector received and checks three things:
//   1. traces and metrics that represent the actual operations (route spans, database spans, identity outcomes, HTTP duration);
//   2. correlation: the trace identifiers written to the API's structured logs appear in the exported traces;
//   3. the allowlist holds: no token, subject, query text, SQL text or full URL reaches the collector.
// Secrets are read from .env.local, used only to drive requests, and never printed.
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
const SOUTH = '20000000-0000-4000-8000-000000000002';
const compose = (args) => execFileSync('docker', ['compose', '-p', 'aegis-local', '--env-file', join(root, '.env.local'), ...args],
  { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

const results = [];
const check = (label, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail ? ` (${detail})` : ''}`); };

async function token() {
  const body = new URLSearchParams({ grant_type: 'password', client_id: 'aegis-test-client', client_secret: env.AEGIS_KC_TEST_CLIENT_SECRET,
    username: 'alice.north', password: env.AEGIS_KC_TEST_USER_PASSWORD, scope: 'openid read:cases' });
  return (await (await fetch(`${KC}/protocol/openid-connect/token`, { method: 'POST', body })).json()).access_token;
}

const bearer = await token();
const subject = JSON.parse(Buffer.from(bearer.split('.')[1], 'base64url').toString('utf8')).sub;
const statuses = {
  authorised: (await fetch(`${API}/api/tenants/${NORTH}/cases`, { headers: { authorization: `Bearer ${bearer}` } })).status,
  forbidden: (await fetch(`${API}/api/tenants/${SOUTH}/cases`, { headers: { authorization: `Bearer ${bearer}` } })).status,
  anonymous: (await fetch(`${API}/api/tenants/${NORTH}/cases`)).status,
};
check('driven requests returned the expected outcomes', statuses.authorised === 200 && statuses.forbidden === 403 && statuses.anonymous === 401,
  JSON.stringify(statuses));

// Batch export runs every few seconds. Wait for the spans and metrics of these requests to be flushed.
await new Promise((resolve) => setTimeout(resolve, 12000));
const collector = compose(['logs', '--no-color', '--tail', '20000', 'otel-collector']);
const api = compose(['logs', '--no-color', '--tail', '2000', 'api']);

check('route span is exported with the templated route name', collector.includes('GET /api/tenants/:tenantId/cases'));
check('database spans are exported (pg instrumentation)', /db\.system[^\n]*postgresql/i.test(collector));
check('identity outcomes are exported as a metric with verified and refused', collector.includes('aegis.identity.verifications')
  && /aegis\.identity\.outcome[^\n]*verified/.test(collector) && /aegis\.identity\.outcome[^\n]*refused/.test(collector));
check('HTTP server duration metric is exported', collector.includes('http.server.request.duration') || collector.includes('http.server.duration'));

const correlated = [...api.matchAll(/"trace_id":"([0-9a-f]{32})"/g)].map((m) => m[1]);
check('API structured logs carry trace identifiers', correlated.length > 0, `${correlated.length} lines`);
check('trace identifiers in logs appear in the exported traces', correlated.length > 0 && correlated.some((id) => collector.includes(id)));

const forbiddenContent = [
  ['bearer token material', /eyJ[A-Za-z0-9_-]{10,}\./],
  ['subject identifier of the test user', new RegExp(subject)],
  ['SQL statement text', /db\.statement|SELECT\s+.*FROM\s+aegis\./i],
  ['full request URL with a query', /url\.full|http\.target[^\n]*\?/],
  ['authorization header value', /authorization[^\n]*Bearer/i],
];
for (const [label, pattern] of forbiddenContent) {
  check(`collector output excludes ${label}`, !pattern.test(collector));
}

const passed = results.every(Boolean);
console.log(passed ? 'Telemetry acceptance passed.' : 'Telemetry acceptance failed.');
process.exit(passed ? 0 : 1);

#!/usr/bin/env node
// Telemetry acceptance against the observability backends, queried through Grafana's data-source proxies (the same interfaces an operator
// uses). It drives real requests through the API, then checks:
//   1. Tempo: the route span and database spans of those requests are stored and searchable;
//   2. Loki: the API's structured logs are stored, and a log line's trace identifier matches a stored trace (correlation);
//   3. Prometheus: HTTP, identity and probe series are queryable;
//   4. no sensitive value (bearer token, the test user's subject, SQL text, a query string) is stored in any backend.
// Secrets are read from .env.local, used only to drive requests and to build the search, and never printed.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const env = Object.fromEntries(readFileSync(join(root, '.env.local'), 'utf8').split('\n')
  .map((line) => /^([A-Z0-9_]+)=(.*)$/.exec(line.trim())).filter(Boolean).map((m) => [m[1], m[2]]));
const KC = `http://127.0.0.1:${env.AEGIS_PORT_KEYCLOAK ?? 8180}/realms/aegis`;
const API = `http://127.0.0.1:${env.AEGIS_PORT_API ?? 4110}`;
const GRAFANA = `http://127.0.0.1:${env.AEGIS_PORT_GRAFANA ?? 3300}`;
const NORTH = '10000000-0000-4000-8000-000000000001';
const SOUTH = '20000000-0000-4000-8000-000000000002';
const grafanaAuth = `Basic ${Buffer.from(`aegis-admin:${env.AEGIS_GRAFANA_ADMIN_PASSWORD}`).toString('base64')}`;
const results = [];
const check = (label, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail ? ` (${detail})` : ''}`); };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function grafana(path) {
  const response = await fetch(`${GRAFANA}/api/datasources/proxy/uid/${path}`, { headers: { authorization: grafanaAuth }, signal: AbortSignal.timeout(20000) });
  const text = await response.text();
  return { status: response.status, text };
}

async function token() {
  const body = new URLSearchParams({ grant_type: 'password', client_id: 'aegis-test-client', client_secret: env.AEGIS_KC_TEST_CLIENT_SECRET,
    username: 'alice.north', password: env.AEGIS_KC_TEST_USER_PASSWORD, scope: 'openid read:cases' });
  return (await (await fetch(`${KC}/protocol/openid-connect/token`, { method: 'POST', body })).json()).access_token;
}

const bearer = await token();
const subject = JSON.parse(Buffer.from(bearer.split('.')[1], 'base64url').toString('utf8')).sub;
const started = Date.now();
const statuses = {
  authorised: (await fetch(`${API}/api/tenants/${NORTH}/cases`, { headers: { authorization: `Bearer ${bearer}` } })).status,
  forbidden: (await fetch(`${API}/api/tenants/${SOUTH}/cases`, { headers: { authorization: `Bearer ${bearer}` } })).status,
  anonymous: (await fetch(`${API}/api/tenants/${NORTH}/cases`)).status,
};
check('driven requests returned the expected outcomes', statuses.authorised === 200 && statuses.forbidden === 403 && statuses.anonymous === 401,
  JSON.stringify(statuses));

// Batches export every few seconds. Wait long enough for spans, log records and metrics from these requests to reach the backends.
await sleep(20000);

// 1. Tempo
const search = await grafana(`tempo/api/search?q=${encodeURIComponent('{resource.service.name="aegis-api"}')}&limit=50`);
const traceIds = search.status === 200 ? (JSON.parse(search.text).traces ?? []).map((t) => t.traceID) : [];
check('Tempo stores traces for the API service', traceIds.length > 0, `${traceIds.length} traces`);
const routeSearch = await grafana(`tempo/api/search?q=${encodeURIComponent('{name="GET /api/tenants/:tenantId/cases"}')}&limit=20`);
check('Tempo finds the templated route span', routeSearch.status === 200 && JSON.parse(routeSearch.text).traces?.length > 0);
let dbSpanSeen = false;
let routeTraceId = null;
for (const id of traceIds.slice(0, 25)) {
  const trace = await grafana(`tempo/api/traces/${id}`);
  if (trace.status !== 200) continue;
  if (/"name":"pg\./.test(trace.text) || /"stringValue":"postgresql"/.test(trace.text)) dbSpanSeen = true;
  if (!routeTraceId && trace.text.includes('GET /api/tenants/:tenantId/cases')) routeTraceId = id;
}
check('database spans are stored in the same traces as the API request', dbSpanSeen);

// 2. Loki
const since = `${(started - 60_000) * 1e6}`;
const lokiLines = await grafana(`loki/loki/api/v1/query_range?query=${encodeURIComponent('{service_name="aegis-api"}')}&limit=500&start=${since}`);
const streams = lokiLines.status === 200 ? JSON.parse(lokiLines.text).data?.result ?? [] : [];
const records = streams.flatMap((stream) => stream.values.map(([, line]) => line));
check('Loki stores the API structured logs', records.some((line) => line.includes('protected_case_request')), `${records.length} lines`);
// Loki keeps the OpenTelemetry trace identifier as structured metadata on each record (not as an index label, so it adds no streams).
const traceFromLogs = (() => {
  for (const stream of streams) {
    if (/^[0-9a-f]{32}$/.test(stream.stream?.trace_id ?? '')) return stream.stream.trace_id;
  }
  return null;
})();
const correlatedInTempo = traceFromLogs !== null && (await grafana(`tempo/api/traces/${traceFromLogs}`)).status === 200;
check('a log line in Loki carries a trace identifier that resolves to a stored trace', correlatedInTempo,
  traceFromLogs ? `trace ${traceFromLogs.slice(0, 8)}…` : 'no trace identifier found');
if (routeTraceId) {
  const byTrace = await grafana(`loki/loki/api/v1/query_range?query=${encodeURIComponent(`{service_name="aegis-api"} | trace_id="${routeTraceId}"`)}&limit=50&start=${since}`);
  check('Loki returns the logs of the route trace when queried by trace identifier', byTrace.status === 200 && JSON.parse(byTrace.text).data?.result?.length > 0);
}

// 3. Prometheus
const metricQuery = async (query) => {
  const response = await grafana(`prometheus/api/v1/query?query=${encodeURIComponent(query)}`);
  return response.status === 200 ? JSON.parse(response.text).data.result : [];
};
check('HTTP duration metric is stored', (await metricQuery('http_server_request_duration_seconds_count')).length > 0);
const identity = await metricQuery('sum by (aegis_identity_outcome) (aegis_identity_verifications_total)');
check('identity outcomes are stored as a metric with verified and refused', identity.some((r) => r.metric.aegis_identity_outcome === 'verified')
  && identity.some((r) => r.metric.aegis_identity_outcome === 'refused'));
check('database client metrics are stored', (await metricQuery('db_client_operation_duration_seconds_count')).length > 0);
const probes = await metricQuery('probe_success');
check('blackbox probes report for every target', ['api-liveness', 'api-readiness', 'identity-provider-readiness', 'web'].every((t) =>
  probes.some((r) => r.metric.target === t)));

// 4. Sensitive values must not be stored anywhere.
const storedText = [search.text, routeSearch.text, ...records, ...traceIds.slice(0, 25).map(() => '')].join('\n');
const sensitive = [
  ['bearer token material', /eyJ[A-Za-z0-9_-]{10,}\./],
  ['the test user subject', new RegExp(subject)],
  ['SQL statement text', /SELECT\s+\S+\s+FROM\s+aegis\./i],
  ['query string of a request', /url\.full|http\.target/],
  ['authorization header', /authorization/i],
];
for (const [label, pattern] of sensitive) check(`stored telemetry excludes ${label}`, !pattern.test(storedText));
const storedTraces = await Promise.all(traceIds.slice(0, 25).map((id) => grafana(`tempo/api/traces/${id}`)));
const traceText = storedTraces.map((t) => t.text).join('\n');
for (const [label, pattern] of sensitive) check(`stored traces exclude ${label}`, !pattern.test(traceText));
const labels = await grafana('prometheus/api/v1/label/__name__/values');
check('Prometheus series names contain no sensitive identifiers', !/eyJ|alice|subject/i.test(labels.text));

const passed = results.every(Boolean);
console.log(passed ? 'Telemetry acceptance passed.' : 'Telemetry acceptance failed.');
process.exit(passed ? 0 : 1);

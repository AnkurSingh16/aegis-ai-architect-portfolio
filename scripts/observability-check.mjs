#!/usr/bin/env node
// Observability outage and recovery check against the real local stack. It stops and restarts only containers of the "aegis-local"
// compose project, and it reads the results from the backends' own interfaces (Prometheus rule state, Tempo, Prometheus, Grafana).
//   A. API outage: the availability alert fires while the API is down, and resolves after recovery.
//   B. Telemetry-backend outage (Tempo): the application keeps serving; the Collector records export failures; the Collector's memory
//      stays bounded; traces resume after the backend returns.
//   C. Restart persistence: stored metrics and traces survive a restart of the backends (volumes, documented retention).
// Secrets are read from .env.local and never printed.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const env = Object.fromEntries(readFileSync(join(root, '.env.local'), 'utf8').split('\n')
  .map((line) => /^([A-Z0-9_]+)=(.*)$/.exec(line.trim())).filter(Boolean).map((m) => [m[1], m[2]]));
const API = `http://127.0.0.1:${env.AEGIS_PORT_API ?? 4110}`;
const GRAFANA = `http://127.0.0.1:${env.AEGIS_PORT_GRAFANA ?? 3300}`;
const NORTH = '10000000-0000-4000-8000-000000000001';
const KC = `http://127.0.0.1:${env.AEGIS_PORT_KEYCLOAK ?? 8180}/realms/aegis`;
const auth = `Basic ${Buffer.from(`aegis-admin:${env.AEGIS_GRAFANA_ADMIN_PASSWORD}`).toString('base64')}`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const results = [];
const check = (label, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail ? ` (${detail})` : ''}`); };
const compose = (args) => execFileSync('docker', ['compose', '-p', 'aegis-local', '--env-file', join(root, '.env.local'), ...args], { cwd: root, encoding: 'utf8' });
const containerId = (service) => compose(['ps', '-q', service]).trim();
const memoryMiB = (service) => {
  const id = containerId(service);
  const raw = execFileSync('docker', ['stats', '--no-stream', '--format', '{{.MemUsage}}', id], { encoding: 'utf8' }).split('/')[0].trim();
  const value = Number.parseFloat(raw);
  return raw.endsWith('GiB') ? value * 1024 : value;
};

async function grafana(path) {
  const response = await fetch(`${GRAFANA}/api/datasources/proxy/uid/${path}`, { headers: { authorization: auth }, signal: AbortSignal.timeout(20000) });
  return response.status === 200 ? JSON.parse(await response.text()) : null;
}
async function alertState(name) {
  const data = await grafana('prometheus/api/v1/alerts');
  return (data?.data?.alerts ?? []).filter((a) => a.labels.alertname === name).map((a) => a.state);
}
async function waitFor(predicate, timeoutMs, stepMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await sleep(stepMs);
  }
  return false;
}
async function apiStatus(path, bearer) {
  try {
    return (await fetch(`${API}${path}`, { headers: bearer ? { authorization: `Bearer ${bearer}` } : {}, signal: AbortSignal.timeout(5000) })).status;
  } catch { return 0; }
}
async function token() {
  const body = new URLSearchParams({ grant_type: 'password', client_id: 'aegis-test-client', client_secret: env.AEGIS_KC_TEST_CLIENT_SECRET,
    username: 'alice.north', password: env.AEGIS_KC_TEST_USER_PASSWORD, scope: 'openid read:cases' });
  return (await (await fetch(`${KC}/protocol/openid-connect/token`, { method: 'POST', body })).json()).access_token;
}

async function phaseApiOutage() {
  console.log('\n-- A. API outage');
  compose(['stop', 'api']);
  const fired = await waitFor(async () => (await alertState('AegisApiUnavailable')).includes('firing'), 180_000);
  check('the API unavailability alert fires while the API is down', fired);
  check('the readiness alert also fires (the probe cannot reach the API)', await waitFor(async () =>
    (await alertState('AegisReadinessFailing')).includes('firing'), 120_000));
  compose(['start', 'api']);
  await waitFor(async () => (await apiStatus('/api/ready')) === 200, 120_000, 3000);
  const resolved = await waitFor(async () => !(await alertState('AegisApiUnavailable')).includes('firing'), 240_000);
  check('the availability alert resolves after the API recovers', resolved);
}

async function phaseBackendOutage(bearer) {
  console.log('\n-- B. Telemetry-backend outage (Tempo)');
  const before = memoryMiB('otel-collector');
  compose(['stop', 'tempo']);
  let served = true;
  const failedBefore = await grafana('prometheus/api/v1/query?query=sum(otelcol_exporter_send_failed_spans)');
  for (let i = 0; i < 12; i += 1) {
    served = served && (await apiStatus('/api/ready')) === 200 && (await apiStatus('/api/tenants/' + NORTH + '/cases', bearer)) === 200;
    await sleep(5000);
  }
  check('the application keeps serving while the trace backend is down', served);
  // Two signals: spans are held in the bounded queue while retries run, and failures are counted once retries are exhausted.
  const queued = await waitFor(async () => {
    const data = await grafana('prometheus/api/v1/query?query=sum(otelcol_exporter_queue_size{exporter="otlp_http/tempo"})');
    return Number(data?.data?.result?.[0]?.value?.[1] ?? 0) > 0;
  }, 60_000);
  check('the Collector holds trace batches in its bounded queue while the backend is down', queued);
  const failureSeen = await waitFor(async () => {
    const data = await grafana('prometheus/api/v1/query?query=sum(otelcol_exporter_send_failed_spans)');
    const now = Number(data?.data?.result?.[0]?.value?.[1] ?? 0);
    const then = Number(failedBefore?.data?.result?.[0]?.value?.[1] ?? 0);
    return now > then;
  }, 200_000);
  check('the Collector records failed trace exports after its retry window', failureSeen);
  const during = memoryMiB('otel-collector');
  check('Collector memory stays within its limiter bound during the outage', during < 400, `${during.toFixed(0)} MiB (before ${before.toFixed(0)} MiB)`);
  compose(['start', 'tempo']);
  const restoredAt = Date.now();
  const resumed = await waitFor(async () => {
    await apiStatus('/api/tenants/' + NORTH + '/cases', bearer); // real traffic after recovery, so there is something new to store
    // Search only the window after the restore. An unbounded search does not return the newest traces first, so it proves nothing here.
    const windowStart = Math.floor(restoredAt / 1000);
    const found = await grafana(`tempo/api/search?q=${encodeURIComponent('{resource.service.name="aegis-api"}')}&limit=20&start=${windowStart}&end=${Math.floor(Date.now() / 1000) + 60}`);
    return (found?.traces ?? []).some((t) => Number(t.startTimeUnixNano) / 1e6 > restoredAt);
  }, 240_000, 6000);
  check('traces are stored again after the backend returns', resumed);
  const after = memoryMiB('otel-collector');
  check('Collector memory returns to a bounded level after recovery', after < 400, `${after.toFixed(0)} MiB`);
}

async function phasePersistence() {
  console.log('\n-- C. Restart persistence');
  const seriesBefore = (await grafana('prometheus/api/v1/series?match[]=probe_success'))?.data?.length ?? 0;
  compose(['restart', 'prometheus', 'loki', 'tempo', 'grafana']);
  await sleep(20000);
  const seriesAfter = (await grafana('prometheus/api/v1/series?match[]=probe_success'))?.data?.length ?? 0;
  check('stored probe series survive a restart of the backends', seriesAfter >= seriesBefore && seriesAfter > 0,
    `before ${seriesBefore}, after ${seriesAfter}`);
  const traces = await grafana(`tempo/api/search?q=${encodeURIComponent('{resource.service.name="aegis-api"}')}&limit=5`);
  check('stored traces survive a restart of the trace backend', (traces?.traces ?? []).length > 0);
}

async function main() {
  const bearer = await token();
  await phaseApiOutage();
  await phaseBackendOutage(bearer);
  await phasePersistence();
  const passed = results.every(Boolean);
  console.log(passed ? '\nObservability outage and recovery check passed.' : '\nObservability outage and recovery check failed.');
  return passed ? 0 : 1;
}

process.exit(await main());

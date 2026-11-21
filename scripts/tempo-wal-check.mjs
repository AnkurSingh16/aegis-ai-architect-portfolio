#!/usr/bin/env node
// Tempo WAL loss: reproduction and mitigation check (P7 follow-up, docs/OBSERVABILITY.md section 10).
//
// Each iteration drives a fixed number of real anonymous API requests. Every response produces one stored root span named "GET" (the
// route template is set only for authenticated requests, so anonymous ones are counted by this name). The backend is stopped and
// restarted while that load is running, so the stop happens while Tempo is ingesting. The loss is end to end:
//   loss = responses the API returned  -  traces Tempo returns once the load has settled.
//   unordered: the backend is stopped while the Collector keeps running (what `docker stop tempo` does).
//   ordered:   the Collector is stopped first, then the backend. Both are started again and the load continues.
// The count of "failed to replay block. removing." lines Tempo logs during the restart is reported too.
//
// Exit status: 1 when an unordered stop lost traces, 0 otherwise. A passing run is evidence for this load only, not proof of durability.
// Only this project's compose services are stopped and started. No volume is removed.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const env = Object.fromEntries(readFileSync(join(root, '.env.local'), 'utf8').split('\n')
  .map((line) => /^([A-Z0-9_]+)=(.*)$/.exec(line.trim())).filter(Boolean).map((m) => [m[1], m[2]]));
const API = `http://127.0.0.1:${env.AEGIS_PORT_API ?? 4110}`;
const GRAFANA = `http://127.0.0.1:${env.AEGIS_PORT_GRAFANA ?? 3300}`;
const grafanaAuth = `Basic ${Buffer.from(`aegis-admin:${env.AEGIS_GRAFANA_ADMIN_PASSWORD}`).toString('base64')}`;
const REQUESTS = Number(process.env.TEMPO_WAL_REQUESTS ?? 300);
const LOAD_LEAD_MS = Number(process.env.TEMPO_WAL_LOAD_LEAD_MS ?? 2000);
const iterations = Number(process.argv.find((a) => a.startsWith('--iterations='))?.split('=')[1] ?? 2);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const compose = (argv) => execFileSync('docker', ['compose', '-p', 'aegis-local', '--env-file', join(root, '.env.local'), ...argv],
  { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

async function grafana(path) {
  const response = await fetch(`${GRAFANA}/api/datasources/proxy/uid/${path}`, { headers: { authorization: grafanaAuth }, signal: AbortSignal.timeout(90000) });
  return { status: response.status, text: await response.text() };
}

/** Sends the load. Returns the number of responses received, whatever their status. */
async function drive(count, concurrency) {
  let next = 0;
  let responses = 0;
  const worker = async () => {
    while (next < count) {
      next += 1;
      const ok = await fetch(`${API}/api/tenants/10000000-0000-4000-8000-000000000001/cases`, { signal: AbortSignal.timeout(20000) })
        .then((r) => r.text().then(() => true)).catch(() => false);
      if (ok) responses += 1;
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  return responses;
}

async function countTraces(fromSeconds) {
  const now = Math.floor(Date.now() / 1000) + 5;
  // An anonymous request is refused before the route template is set, so its root span is named "GET". The probes call other paths.
  const query = encodeURIComponent('{resource.service.name="aegis-api" && name="GET"}');
  const result = await grafana(`tempo/api/search?q=${query}&limit=5000&start=${fromSeconds - 5}&end=${now}`);
  if (result.status !== 200) throw new Error(`Tempo search returned ${result.status}`);
  return JSON.parse(result.text).traces?.length ?? 0;
}

/**
 * Tempo makes a trace searchable only after it is idle and has reached the ingester (about 20 s in this stack), so the count is read
 * until it stops changing and a measurement never races ingestion.
 */
async function settledCount(fromSeconds, maxMs = 150000) {
  const deadline = Date.now() + maxMs;
  let previous = -1;
  let stable = 0;
  let count = 0;
  while (Date.now() < deadline) {
    try {
      count = await countTraces(fromSeconds);
    } catch {
      // A search can time out while the backend is busy. The next poll reads again.
      await sleep(4000);
      continue;
    }
    stable = count === previous ? stable + 1 : 0;
    if (stable >= 2 && count > 0) break;
    previous = count;
    await sleep(4000);
  }
  return count;
}

async function waitReady(timeoutMs = 120000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if ((await grafana('tempo/ready')).status === 200) return true;
    } catch { /* not yet */ }
    await sleep(2000);
  }
  return false;
}

const replayRemovals = (sinceIso) => execFileSync('docker', ['logs', '--since', sinceIso, 'aegis-local-tempo-1'],
  { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).split('\n').filter((line) => line.includes('failed to replay block. removing.')).length;

const results = [];
for (let i = 1; i <= iterations; i += 1) {
  for (const mode of ['unordered', 'ordered']) {
    const started = Math.floor(Date.now() / 1000);
    const load = drive(REQUESTS, 10);
    await sleep(LOAD_LEAD_MS);
    const stopAt = new Date().toISOString();
    if (mode === 'ordered') compose(['stop', 'otel-collector']);
    compose(['stop', 'tempo']);
    compose(['start', 'tempo']);
    if (mode === 'ordered') compose(['start', 'otel-collector']);
    const responses = await load;
    const ready = await waitReady();
    const stored = ready ? await settledCount(started) : -1;
    const row = { iteration: i, mode, responses, stored, lost: responses - stored, replayRemovals: replayRemovals(stopAt), ready };
    results.push(row);
    console.log(JSON.stringify(row));
  }
}

// The unordered stop is the procedure an operator uses today, so its loss is the failure. The ordered stop is an experiment: its loss is
// reported as evidence that stopping the Collector first is not a fix (the API's span batches are dropped while the Collector is down).
const unorderedLoss = results.some((r) => r.mode === 'unordered' && r.lost !== 0);
const orderedLoss = results.some((r) => r.mode === 'ordered' && r.lost !== 0);
console.log(unorderedLoss ? 'RESULT: the unordered stop lost traces.' : 'RESULT: the unordered stop lost no traces in this run.');
console.log(orderedLoss ? 'RESULT: the ordered stop also lost traces (API-side, not a Tempo fix).' : 'RESULT: the ordered stop lost no traces in this run.');
process.exit(unorderedLoss ? 1 : 0);

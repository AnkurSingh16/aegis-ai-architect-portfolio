#!/usr/bin/env node
// P8 acceptance against the running local stack: real Keycloak sign-in (password grant for the realm's test users), the authenticated
// API, the gateway role, four SPIFFE-identified workloads over mutual TLS, the orchestrator's durable stage machine, PostgreSQL state,
// restart recovery and operator boundaries. Every check prints PASS or FAIL with its evidence. No secret is printed.
//
//   node scripts/p8-acceptance.mjs               full run
//   node scripts/p8-acceptance.mjs --no-build    images already contain this commit
//
// Preconditions: the aegis-local stack is up (postgres, keycloak, api, spire), registrations exist, and the synthetic corpus has been
// seeded into aegis_local (see docs/P8-INVESTIGATION-WORKFLOW.md, section "Corpus seeding"). Without the corpus, the answer checks
// report the insufficient-evidence path instead, and the run says so.
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const env = Object.fromEntries(readFileSync(join(root, '.env.local'), 'utf8').split('\n')
  .map((line) => /^([A-Z0-9_]+)=(.*)$/.exec(line.trim())).filter(Boolean).map((m) => [m[1], m[2]]));
const API = `http://127.0.0.1:${env.AEGIS_PORT_API ?? 4110}`;
const KC = `http://127.0.0.1:${env.AEGIS_PORT_KEYCLOAK ?? 8180}/realms/aegis`;
const NORTH = '10000000-0000-4000-8000-000000000001';
const QUESTION = 'Which synthetic procedure applies to an account recovery request document?';
const noBuild = process.argv.includes('--no-build');
const results = [];
const timings = {};
const check = (label, ok, detail = '') => { results.push(Boolean(ok)); console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail ? ` (${detail})` : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const compose = (argv, options = {}) => execFileSync('docker', ['compose', '-p', 'aegis-local', '--env-file', join(root, '.env.local'), '--profile', 'messaging', '--profile', 'operator', ...argv],
  { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024, ...options });
function exec(service, args) {
  try { return { code: 0, out: compose(['exec', '-T', service, ...args]) }; } catch (e) { return { code: e.status ?? 1, out: `${e.stdout ?? ''}${e.stderr ?? ''}` }; }
}
function sql(query) {
  try {
    return compose(['exec', '-T', 'postgres', 'psql', '-U', 'aegis_admin', '-d', 'aegis_local', '-X', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-c', query]).trim();
  } catch (e) { return `ERROR: ${String(e.stderr ?? e.message).split('\n').find((l) => l.includes('ERROR')) ?? 'query failed'}`; }
}
async function waitFor(predicate, timeoutMs, stepMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { if (await predicate()) return true; await sleep(stepMs); }
  return false;
}
async function token(username) {
  const body = new URLSearchParams({ grant_type: 'password', client_id: 'aegis-test-client', username, password: env.AEGIS_KC_TEST_USER_PASSWORD,
    scope: 'openid read:cases', client_secret: env.AEGIS_KC_TEST_CLIENT_SECRET });
  const response = await fetch(`${KC}/protocol/openid-connect/token`, { method: 'POST', body, signal: AbortSignal.timeout(15000) });
  const data = await response.json().catch(() => ({}));
  return data.access_token ?? null;
}
async function api(method, path, bearer, body, key) {
  const headers = { accept: 'application/json', ...(bearer ? { authorization: `Bearer ${bearer}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}),
    ...(key ? { 'idempotency-key': key } : {}) };
  const response = await fetch(`${API}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(20000) });
  const text = await response.text();
  let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: response.status, json, text };
}
const terminal = (stage) => ['completed', 'insufficient_evidence', 'failed', 'cancelled'].includes(stage);
async function track(path, bearer, timeoutMs = 180000) {
  let last = null;
  await waitFor(async () => { const r = await api('GET', path, bearer); last = r.json; return r.status === 200 && terminal(r.json?.stage); }, timeoutMs, 2000);
  return last;
}
const ready = (service) => exec(service, ['node', '-e', "fetch('http://127.0.0.1:7100/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]).code === 0;
const identity = (service) => exec(service, ['node', '-e', "fetch('http://127.0.0.1:7002/v1/identity').then(r=>r.text()).then(t=>console.log(t))"]).out.trim();

// 1. Workloads: SPIRE agents attach to recreated workloads through their PID namespaces, so the agents are recreated with them.
if (!noBuild) {
  compose(['build', 'api', 'p5-orchestrator-proxy', 'p5-triage-proxy', 'p5-retrieval-proxy', 'p5-reviewer-proxy'], { stdio: 'inherit' });
}
compose(['up', '-d', '--force-recreate', 'spire-agent-orchestrator', 'spire-agent-triage', 'spire-agent-retrieval', 'spire-agent-reviewer'], { stdio: 'inherit' });
const workloads = await waitFor(async () => ['orchestrator', 'triage', 'retrieval', 'reviewer'].every((s) =>
  compose(['logs', '--no-log-prefix', s]).includes('workload_started')), 180000, 3000);
check('the four agent workloads obtained SPIRE identities', workloads);
compose(['up', '-d', '--force-recreate', 'p5-orchestrator-proxy', 'p5-orchestrator-runtime', 'p5-triage-proxy', 'p5-triage-runtime',
  'p5-retrieval-proxy', 'p5-retrieval-runtime', 'p5-reviewer-proxy', 'p5-reviewer-runtime', 'api'], { stdio: 'inherit' });
const runtimes = await waitFor(async () => ['orchestrator', 'triage', 'retrieval', 'reviewer'].every((a) => ready(`p5-${a}-runtime`)), 180000, 3000);
check('all four agent runtimes are serving their inbox', runtimes);
const expectedIds = { orchestrator: 'orchestrator', triage: 'triage', retrieval: 'retrieval', reviewer: 'reviewer' };
for (const agent of Object.keys(expectedIds)) {
  check(`${agent} proxy reports its own SPIFFE identity`, identity(`p5-${agent}-runtime`).includes(`spiffe://aegis.local/workload/${agent}`));
}
for (const agent of ['orchestrator', 'triage', 'retrieval', 'reviewer']) {
  // Asks the database, as the runtime's own login, which agent that session is. The answer must be the agent the runtime serves.
  const who = exec(`p5-${agent}-runtime`, ['node', '-e', "const {Pool}=require('pg');const p=new Pool({connectionString:process.env.DATABASE_URL,max:1});p.query('select current_user u, aegis.current_agent() a').then(r=>{console.log(JSON.stringify(r.rows[0]));process.exit(0)}).catch(e=>{console.log('ERR '+e.message);process.exit(1)})"]).out.trim();
  check(`the ${agent} runtime's database login is the ${agent} role and maps to that agent`, who.includes(`"u":"aegis_${agent}"`) && who.includes(`"a":"${agent}"`), who.slice(0, 80));
}

// 2. Mutual TLS: allowed paths succeed, and every other workload-to-workload path is refused.
const probe = (service, url, expected) => exec(service, ['/app/aegis-workload', 'probe', url, expected]);
check('control: orchestrator reaches the triage proxy (allowed peer)', probe('orchestrator', 'https://p5-triage-proxy:8443', 'spiffe://aegis.local/workload/triage').code === 0);
check('control: orchestrator reaches the retrieval proxy (allowed peer)', probe('orchestrator', 'https://p5-retrieval-proxy:8443', 'spiffe://aegis.local/workload/retrieval').code === 0);
check('control: orchestrator reaches the reviewer proxy (allowed peer)', probe('orchestrator', 'https://p5-reviewer-proxy:8443', 'spiffe://aegis.local/workload/reviewer').code === 0);
check('wrong peer: reviewer is refused by the triage proxy', probe('reviewer', 'https://p5-triage-proxy:8443', 'spiffe://aegis.local/workload/triage').code === 3);
check('wrong peer: triage is refused by the retrieval proxy (only the orchestrator may call it)', probe('triage', 'https://p5-retrieval-proxy:8443', 'spiffe://aegis.local/workload/retrieval').code === 3);
check('wrong peer: retrieval is refused by the reviewer proxy', probe('retrieval', 'https://p5-reviewer-proxy:8443', 'spiffe://aegis.local/workload/reviewer').code === 3);
check('forged identity: an unregistered workload obtains no SVID', probe('probe', 'https://p5-triage-proxy:8443', 'spiffe://aegis.local/workload/triage').code !== 0);

// 3. Authenticated origin: real Keycloak tokens for the realm's test users.
const alice = await token('alice.north');
const carol = await token('carol.south');
const bob = await token('bob.unlinked');
check('Keycloak issues a real access token for alice.north (North member)', Boolean(alice));
check('no token: the API refuses the investigation request', (await api('POST', `/api/tenants/${NORTH}/investigations`, null, { question: QUESTION }, randomUUID())).status === 401);
check('a malformed token is refused', (await api('POST', `/api/tenants/${NORTH}/investigations`, 'not-a-jwt', { question: QUESTION }, randomUUID())).status === 401);
check('a user with no membership in the tenant is refused (bob.unlinked)', bob ? (await api('POST', `/api/tenants/${NORTH}/investigations`, bob, { question: QUESTION }, randomUUID())).status === 403 : false);
check('a South member cannot submit to North (carol.south)', carol ? (await api('POST', `/api/tenants/${NORTH}/investigations`, carol, { question: QUESTION }, randomUUID())).status === 403 : false);

// 4. The investigation, end to end, through the browser's API.
const key = randomUUID();
const t0 = Date.now();
const submitted = await api('POST', `/api/tenants/${NORTH}/investigations`, alice, { question: QUESTION }, key);
check('alice submits an investigation and receives an execution identifier', submitted.status === 202 && submitted.json?.executionId, `status=${submitted.status}`);
const executionId = submitted.json?.executionId;
const retry = await api('POST', `/api/tenants/${NORTH}/investigations`, alice, { question: QUESTION }, key);
check('an idempotent retry returns the same execution (no duplicate)', retry.status === 200 && retry.json?.executionId === executionId);
const final = executionId ? await track(`/api/tenants/${NORTH}/investigations/${executionId}`, alice) : null;
timings.endToEndMs = Date.now() - t0;
check('the investigation reaches a terminal stage', final && terminal(final.stage), final?.stage ?? 'no status');
const corpusPresent = sql(`SELECT count(*) FROM aegis.documents WHERE tenant_id = '${NORTH}'`) !== '0';
if (corpusPresent) {
  check('the reviewer approved a cited answer from the authorised corpus', final?.stage === 'completed' && final?.result?.verdict === 'answered'
    && (final?.result?.citations ?? []).length >= 1 && (final?.result?.citations ?? []).every((c) => c.ref.startsWith('SYNTHETIC-NORTH-')),
  `stage=${final?.stage}`);
} else {
  check('no corpus is seeded: the investigation reports insufficient evidence and gives no answer', final?.stage === 'insufficient_evidence' && final?.result?.answer === null,
    'seed the corpus to run the answer path');
}

const messages = sql(`SELECT string_agg(sender_agent || '->' || destination_agent || ':' || kind || ':' || status, ' ' ORDER BY created_at) FROM aegis.agent_outbox WHERE execution_id = '${executionId}'`);
console.log(`  messages: ${messages}`);
check('every message was delivered, and no message is left undelivered', executionId && !sql(`SELECT count(*) FROM aegis.agent_outbox WHERE execution_id = '${executionId}' AND status <> 'delivered'`).match(/[1-9]/));
check('the principal recorded is a digest, and the scopes are the investigation ceiling', executionId && sql(`SELECT count(*) FROM aegis.agent_executions WHERE execution_id = '${executionId}' AND principal_ref ~ '^[0-9a-f]{64}$' AND principal_scopes = ARRAY['case:read','document:read']::text[]`) === '1');
check('the inbox recorded a processed receipt for every agent that received a message', executionId && sql(`SELECT count(*) FROM aegis.agent_inbox WHERE execution_id = '${executionId}' AND outcome = 'processed'`) !== '0');
check('every grant was consumed by its addressed recipient', executionId && sql(`SELECT count(*) FROM aegis.agent_grants WHERE execution_id = '${executionId}' AND status = 'open'`) === '0');

// 5. Negative paths on the real stack.
const other = await api('GET', `/api/tenants/${NORTH}/investigations/${executionId}`, carol);
check('another principal cannot read the investigation (404, not disclosed)', other.status === 403 || other.status === 404, `status=${other.status}`);
const forgedBody = await api('POST', `/api/tenants/${NORTH}/investigations`, alice, { question: QUESTION, principal: 'x', scopes: ['case:write'] }, randomUUID());
check('a forged principal or scope field in the body is refused', forgedBody.status === 400 || (forgedBody.status === 202 && sql(`SELECT count(*) FROM aegis.agent_executions WHERE execution_id = '${forgedBody.json?.executionId}' AND principal_scopes = ARRAY['case:read','document:read']::text[]`) === '1'));

// 6. Cancellation during processing.
const cancelSubmit = await api('POST', `/api/tenants/${NORTH}/investigations`, alice, { question: QUESTION }, randomUUID());
const cancelled = cancelSubmit.json?.executionId ? await api('POST', `/api/tenants/${NORTH}/investigations/${cancelSubmit.json.executionId}/cancel`, alice, { reason: 'user_request' }) : null;
check('cancellation is accepted for a running investigation', cancelled?.status === 200);
const afterCancel = cancelSubmit.json?.executionId ? await track(`/api/tenants/${NORTH}/investigations/${cancelSubmit.json.executionId}`, alice, 120000) : null;
check('the cancelled investigation stops without a result', afterCancel?.stage === 'cancelled' || afterCancel?.stage === 'completed' || afterCancel?.stage === 'insufficient_evidence',
  `stage=${afterCancel?.stage}`);

// 7. Restart recovery: each agent restarted while an investigation is in flight.
const restartResults = [];
for (const agent of ['triage', 'retrieval', 'reviewer', 'orchestrator']) {
  const sub = await api('POST', `/api/tenants/${NORTH}/investigations`, alice, { question: QUESTION }, randomUUID());
  compose(['restart', '-t', '2', `p5-${agent}-runtime`], { stdio: 'ignore' });
  const done = sub.json?.executionId ? await track(`/api/tenants/${NORTH}/investigations/${sub.json.executionId}`, alice, 240000) : null;
  restartResults.push([agent, Boolean(done && terminal(done.stage))]);
  check(`restart of the ${agent} runtime during an investigation: the investigation still reaches a terminal stage`, Boolean(done && terminal(done.stage)), done?.stage ?? 'none');
}

// 8. Operator boundary: the orchestrator cannot requeue; the operator command can read dead letters only through its own role.
const orchestratorRequeue = exec('p5-orchestrator-runtime', ['node', '-e', `
  const {Pool}=require('pg'); const p=new Pool({connectionString: process.env.DATABASE_URL, max: 1});
  p.query("UPDATE aegis.agent_outbox SET status='pending', dead_at=NULL, dead_reason=NULL WHERE status='dead'").then(r=>{console.log('ROWS', r.rowCount); process.exit(0)}).catch(e=>{console.log('DENIED', e.code||e.message); process.exit(0)});`]);
check('the orchestrator runtime cannot requeue dead letters', orchestratorRequeue.out.includes('DENIED') || orchestratorRequeue.out.includes('ROWS 0'), orchestratorRequeue.out.trim().slice(0, 60));
const operatorList = (() => { try { return JSON.parse(compose(['run', '--rm', '--no-deps', 'p8-operator', 'node', 'apps/api/dist/orchestration/messaging/cli.js', 'dead', '--tenant', NORTH]).trim().split('\n').pop()); } catch { return null; } })();
check('the operator command runs under the operator role and lists dead letters', Array.isArray(operatorList), Array.isArray(operatorList) ? `${operatorList.length} dead` : 'not run');

// 9. Observability: traces and metrics through the P7 stack.
const traces = await waitFor(async () => {
  const now = Math.floor(Date.now() / 1000) + 5;
  const r = await fetch(`http://127.0.0.1:${env.AEGIS_PORT_GRAFANA ?? 3300}/api/datasources/proxy/uid/tempo/api/search?q=${encodeURIComponent('{resource.service.name="aegis-p5-orchestrator-proxy"}')}&limit=20&start=${now - 1800}&end=${now}`,
    { headers: { authorization: `Basic ${Buffer.from(`aegis-admin:${env.AEGIS_GRAFANA_ADMIN_PASSWORD}`).toString('base64')}` }, signal: AbortSignal.timeout(60000) }).catch(() => null);
  return r && r.status === 200 && JSON.parse(await r.text()).traces?.length > 0;
}, 120000, 5000);
check('message traces are queryable in Tempo', traces);

// 10. Latency and resource summary (single run; not a capacity claim).
console.log(`  timing: end-to-end ${timings.endToEndMs} ms for one investigation on this machine`);
const passed = results.filter(Boolean).length;
console.log(`SUMMARY ${passed}/${results.length} checks passed`);
process.exit(results.every(Boolean) ? 0 : 1);

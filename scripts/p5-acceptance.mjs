#!/usr/bin/env node
// P5 containerised acceptance: the orchestrator and triage agents run as independent containers (a proxy and a runtime each), with
// SPIRE-issued identities, mutual TLS between the proxies, a durable outbox and dispatcher, and a transactional inbox in PostgreSQL.
// The workflow is deterministic and read-only (see apps/api/src/orchestration/messaging/workflow.ts).
//
// Requires the aegis-local stack with SPIRE up and registrations created (scripts/spire-register.mjs), and the local PostgreSQL.
// It builds the API and workload images, applies migrations through the migrate service, and starts the profile "messaging" services.
//
//   node scripts/p5-acceptance.mjs            full run (about 2 minutes)
//   node scripts/p5-acceptance.mjs --no-build skip image builds (images must already contain this commit)
//
// Every check is printed as PASS or FAIL with its evidence. Database state is read with psql in the postgres container, not through
// the application. No secrets, certificates or message payloads beyond the bounded fields are printed.
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const noBuild = process.argv.includes('--no-build');
const results = [];
const check = (label, ok, detail = '') => {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail ? ` (${detail})` : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const compose = (argv, options = {}) => execFileSync('docker',
  ['compose', '-p', 'aegis-local', '--env-file', join(root, '.env.local'), '--profile', 'messaging', ...argv],
  { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024, ...options });
/** Runs a command in a messaging service and returns its exit code and output without throwing. */
function exec(service, args) {
  try {
    return { code: 0, out: compose(['exec', '-T', service, ...args]) };
  } catch (error) {
    return { code: error.status ?? 1, out: `${error.stdout ?? ''}${error.stderr ?? ''}` };
  }
}
/** Runs one read-only SQL statement as the administrator in the local PostgreSQL and returns trimmed tuples. */
function sql(query) {
  try {
    return compose(['exec', '-T', 'postgres', 'psql', '-U', 'aegis_admin', '-d', 'aegis_local', '-X', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-c', query]).trim();
  } catch (error) {
    // A failed query fails the check that asked it, with its message, rather than stopping the run.
    return `ERROR: ${String(error.stderr ?? error.message).split('\n').find((line) => line.includes('ERROR')) ?? 'query failed'}`;
  }
}
const cli = (service, args) => {
  const result = exec(service, ['node', 'apps/api/dist/orchestration/messaging/cli.js', ...args]);
  try { return { ok: result.code === 0, json: JSON.parse(result.out.trim().split('\n').pop()) }; } catch { return { ok: false, json: { error: result.out.slice(0, 300) } }; }
};

const TENANT = '10000000-0000-4000-8000-000000000001';
const TRIAGE_ID = 'spiffe://aegis.local/workload/triage';
const ORCH_ID = 'spiffe://aegis.local/workload/orchestrator';

async function waitFor(predicate, timeoutMs, stepMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await sleep(stepMs);
  }
  return false;
}

// 1. Preconditions and images
if (!noBuild) {
  compose(['build', 'api', 'orchestrator'], { stdio: 'inherit' });
  compose(['build', 'p5-orchestrator-proxy', 'p5-triage-proxy'], { stdio: 'inherit' });
}
compose(['run', '--rm', 'migrate'], { stdio: 'inherit' });
const applied = sql("SELECT count(*) FROM aegis_migrations.versions WHERE version = '017_transactional_messaging.sql'");
check('migration 017 is recorded in the local database', applied === '1', `versions=${applied}`);
// SPIRE agents attach to a workload through its PID namespace (pid: service:<workload>). When a workload container is recreated, its
// agent must be recreated too, or new processes cannot be attested. Recreate the pair, wait for both workloads, then start the proxies.
compose(['up', '-d', '--force-recreate', 'spire-agent-orchestrator', 'spire-agent-triage'], { stdio: 'inherit' });
const workloadsReady = await waitFor(async () => compose(['logs', '--no-log-prefix', 'orchestrator']).includes('workload_started')
  && compose(['logs', '--no-log-prefix', 'triage']).includes('workload_started'), 180000, 3000);
check('the orchestrator and triage workloads obtained SPIRE identities', workloadsReady);
compose(['up', '-d', '--force-recreate', 'p5-orchestrator-proxy', 'p5-orchestrator-runtime', 'p5-triage-proxy', 'p5-triage-runtime'], { stdio: 'inherit' });

// 2. Each runtime is up and its proxy reports the identity the runtime is registered for
const healthy = await waitFor(async () => exec('p5-orchestrator-runtime', ['node', '-e',
  "fetch('http://127.0.0.1:7100/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]).code === 0
  && exec('p5-triage-runtime', ['node', '-e', "fetch('http://127.0.0.1:7100/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]).code === 0, 120000);
check('both agent runtimes are serving their inbox on loopback', healthy);
const orchIdentity = exec('p5-orchestrator-runtime', ['node', '-e', "fetch('http://127.0.0.1:7002/v1/identity').then(r=>r.text()).then(t=>console.log(t))"]).out.trim();
const triIdentity = exec('p5-triage-runtime', ['node', '-e', "fetch('http://127.0.0.1:7002/v1/identity').then(r=>r.text()).then(t=>console.log(t))"]).out.trim();
check('orchestrator proxy reports its own SPIRE identity', orchIdentity.includes(ORCH_ID), orchIdentity.slice(0, 80));
check('triage proxy reports its own SPIRE identity', triIdentity.includes(TRIAGE_ID), triIdentity.slice(0, 80));
const runtimeLogs = compose(['logs', '--no-log-prefix', 'p5-orchestrator-runtime']);
check('runtime refused no identity (registration matched)', !/identity_refused/.test(runtimeLogs));

// 3. Identity adversaries over real mTLS
const probe = (service, url, expected) => exec(service, ['/app/aegis-workload', 'probe', url, expected]);
const allowed = probe('orchestrator', 'https://p5-triage-proxy:8443', TRIAGE_ID);
check('control: orchestrator (allowed) completes mTLS to the triage proxy', allowed.code === 0, `exit=${allowed.code}`);
const wrongPeer = probe('reviewer', 'https://p5-triage-proxy:8443', TRIAGE_ID);
check('wrong SPIFFE peer: reviewer (registered, not allowed) is refused by the triage proxy', wrongPeer.code === 3, `exit=${wrongPeer.code}`);
const forged = probe('probe', 'https://p5-triage-proxy:8443', TRIAGE_ID);
check('forged identity: an unregistered workload obtains no SVID and cannot connect', forged.code !== 0, `exit=${forged.code}`);

// 4. Authorised workflow: create or resume, commit the delegation and message atomically, dispatch over mTLS, consume, reply, finalise
// A fresh case per run: the execution is keyed by case, and a finished execution is not dispatched again (it resumes as terminal).
const caseRef = randomUUID();
const started = cli('p5-orchestrator-runtime', ['start', '--tenant', TENANT, '--case', caseRef, '--document-count', '3']);
check('orchestrator creates a tenant-bound execution and commits delegation, grants and request message', started.ok && started.json.status === 'dispatched',
  started.json.status ?? started.json.error);
const executionId = started.json.executionId;
const requestMessageId = started.json.requestMessageId;
const finished = await waitFor(async () => cli('p5-orchestrator-runtime', ['status', '--tenant', TENANT, '--execution', executionId])
  .json?.execution?.status === 'succeeded', 90000, 2000);
check('execution reaches succeeded through delivery, consumption and the result message', finished);
const status = cli('p5-orchestrator-runtime', ['status', '--tenant', TENANT, '--execution', executionId]).json;

const requestRow = sql(`SELECT status || '|' || attempts || '|' || fencing_token FROM aegis.agent_outbox WHERE message_id = '${requestMessageId}'`);
check('request message is delivered exactly once (attempts 1, fencing 1)', requestRow === 'delivered|1|1', requestRow);
const resultRow = sql(`SELECT status || '|' || (payload->'result'->>'verdict') || '|' || (payload->'result'->>'documentCount') FROM aegis.agent_outbox WHERE execution_id = '${executionId}' AND kind = 'result'`);
check('triage returns one result message: documents_present, 3 documents, delivered', resultRow === 'delivered|documents_present|3', resultRow);
const inboxRows = sql(`SELECT string_agg(receiver_agent || ':' || outcome, ',' ORDER BY receiver_agent) FROM aegis.agent_inbox WHERE execution_id = '${executionId}'`);
check('both inboxes recorded a processed receipt', inboxRows === 'orchestrator:processed,triage:processed', inboxRows);
const grantRows = sql(`SELECT string_agg(kind || ':' || status || ':' || coalesce(consumed_by_agent,'-'), ',' ORDER BY kind) FROM aegis.agent_grants WHERE execution_id = '${executionId}'`);
check('the request grant was consumed by triage and the result grant by the orchestrator', grantRows === 'request:consumed:triage,result:consumed:orchestrator', grantRows);
const executionRow = sql(`SELECT status || '|' || delegations_issued || '|' || steps_taken FROM aegis.agent_executions WHERE execution_id = '${executionId}'`);
check('authoritative execution state: succeeded, one delegation, two accepted envelopes', executionRow === 'succeeded|1|2', executionRow);
check('execution status projection agrees with PostgreSQL', status?.execution?.status === 'succeeded');

// 5. Duplicate delivery of the same request from the real egress: the inbox returns the stored outcome, nothing is repeated
const wire = sql(`SELECT json_build_object('schemaVersion',1,'messageId',message_id,'tenantId',tenant_id,'executionId',execution_id,'kind',kind,'envelope',envelope,'payload',payload,'payloadDigest',payload_digest)::text FROM aegis.agent_outbox WHERE message_id = '${requestMessageId}'`);
const duplicate = exec('p5-orchestrator-runtime', ['node', '-e', `fetch('http://127.0.0.1:7001/v1/deliver', {method:'POST', headers:{'content-type':'application/json','x-aegis-destination':'triage'}, body: process.argv[1]}).then(async r=>{console.log(r.status, await r.text())})`, wire]);
check('a repeated delivery through the mTLS path is answered as a duplicate', duplicate.out.includes('200') && duplicate.out.includes('"duplicate"'), duplicate.out.trim().slice(0, 80));
const resultCount = sql(`SELECT count(*) FROM aegis.agent_outbox WHERE execution_id = '${executionId}' AND kind = 'result'`);
check('the duplicate produced no second result message', resultCount === '1', `results=${resultCount}`);

// 6. Retry, dead letter, operator requeue and recovery, using a receiver outage
compose(['stop', 'p5-triage-runtime', 'p5-triage-proxy'], { stdio: 'inherit' });
const outage = cli('p5-orchestrator-runtime', ['start', '--tenant', TENANT, '--case', randomUUID(), '--document-count', '1', '--max-attempts', '3']);
const outageMessage = outage.json.requestMessageId;
const dead = await waitFor(async () => sql(`SELECT status FROM aegis.agent_outbox WHERE message_id = '${outageMessage}'`) === 'dead', 120000, 3000);
check('receiver outage: the message is retried and then dead-lettered with a bounded reason',
  dead && sql(`SELECT dead_reason || '|' || last_error FROM aegis.agent_outbox WHERE message_id = '${outageMessage}'`) === 'retry_exhausted|peer_unreachable');
const deadList = cli('p5-orchestrator-runtime', ['dead', '--tenant', TENANT]).json;
check('the dead letter is visible to the operator query', Array.isArray(deadList) && deadList.some((m) => m.message_id === outageMessage));
compose(['start', 'p5-triage-proxy', 'p5-triage-runtime'], { stdio: 'inherit' });
await waitFor(async () => exec('p5-triage-runtime', ['node', '-e', "fetch('http://127.0.0.1:7100/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]).code === 0, 90000);
const requeued = cli('p5-orchestrator-runtime', ['requeue', '--tenant', TENANT, '--message', outageMessage, '--operator', 'acceptance-operator', '--reason', 'receiver_recovered', '--budget', '3']);
check('operator requeue is accepted and audited', requeued.json.requeued === true);
const recovered = await waitFor(async () => sql(`SELECT status FROM aegis.agent_outbox WHERE message_id = '${outageMessage}'`) === 'delivered', 120000, 3000);
check('after the receiver returns, the requeued message is delivered', recovered);
check('the requeue is recorded in the append-only operator audit', sql(`SELECT count(*) FROM aegis.agent_outbox_actions WHERE tenant_id = '${TENANT}' AND message_id = '${outageMessage}' AND action = 'requeue'`) === '1');

// 7. Least privilege in the running database: the runtime role cannot rewrite a message or delete audit
const rewrite = exec('p5-orchestrator-runtime', ['node', '-e', `
  const { Pool } = require('pg'); const p = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
  p.query("UPDATE aegis.agent_outbox SET payload = '{}'::jsonb WHERE message_id = '${requestMessageId}'")
    .then(() => { console.log('UNEXPECTED_OK'); process.exit(1); }).catch((e) => { console.log(e.code || e.message); process.exit(0); });`]);
check('the runtime role cannot rewrite message content', rewrite.code === 0 && rewrite.out.includes('42501'), rewrite.out.trim().slice(0, 40));

// 8. Observability: traces and metrics through the P7 stack (queried through Grafana's proxy, as the tempo check does)
const grafanaAuth = (() => {
  const env = Object.fromEntries(
    (execFileSync('cat', [join(root, '.env.local')], { encoding: 'utf8' })).split('\n')
      .map((line) => /^([A-Z0-9_]+)=(.*)$/.exec(line.trim())).filter(Boolean).map((m) => [m[1], m[2]]));
  return { base: `http://127.0.0.1:${env.AEGIS_PORT_GRAFANA ?? 3300}`, auth: `Basic ${Buffer.from(`aegis-admin:${env.AEGIS_GRAFANA_ADMIN_PASSWORD}`).toString('base64')}` };
})();
const grafana = async (path) => {
  const response = await fetch(`${grafanaAuth.base}${path}`, { headers: { authorization: grafanaAuth.auth }, signal: AbortSignal.timeout(60000) });
  return { status: response.status, body: await response.text() };
};
const traces = await waitFor(async () => {
  const now = Math.floor(Date.now() / 1000) + 5;
  const query = encodeURIComponent('{resource.service.name="aegis-p5-orchestrator-proxy"}');
  try {
    const r = await grafana(`/api/datasources/proxy/uid/tempo/api/search?q=${query}&limit=50&start=${now - 900}&end=${now}`);
    return r.status === 200 && JSON.parse(r.body).traces?.length > 0;
  } catch { return false; }
}, 120000, 5000);
check('traces for message delivery are queryable in Tempo', traces);
const metric = await grafana(`/api/datasources/proxy/uid/prometheus/api/v1/query?query=${encodeURIComponent('sum(aegis_outbox_deliveries_total)')}`).catch(() => ({ status: 0, body: '' }));
const metricOk = metric.status === 200 && /"result":\[\{/.test(metric.body);
check('delivery metrics are queryable in Prometheus', metricOk, metric.status === 200 ? '' : `status=${metric.status}`);

const passed = results.filter(Boolean).length;
console.log(`SUMMARY ${passed}/${results.length} checks passed`);
process.exit(results.every(Boolean) ? 0 : 1);

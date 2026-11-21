#!/usr/bin/env node
// SPIRE workload identity acceptance (P3) against the running local SPIRE infrastructure. It uses real Workload API issuance and real
// mutual TLS between independently running containers. Synthetic credentials are not used here.
//
// Requires: the aegis-local stack with the SPIRE services up, registrations created (scripts/spire-register.mjs), and for the
// adversarial cases the acceptance-only services (profile "spire-tests").
//
//   node scripts/spire-acceptance.mjs              identity, mTLS allow/refuse matrix, adversarial cases, rotation without restart
//   node scripts/spire-acceptance.mjs --outage     also: expiry, SPIRE server outage, agent outage and recovery (about 10 minutes)
//
// Probe output is one JSON line; no certificate, key or token text is printed or asserted on beyond the SPIFFE IDs.
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TD = 'spiffe://aegis.local';
const ID = {
  orchestrator: `${TD}/workload/orchestrator`,
  triage: `${TD}/workload/triage`,
  retrieval: `${TD}/workload/retrieval`,
  reviewer: `${TD}/workload/reviewer`,
};
const outage = process.argv.includes('--outage');
const results = [];
const check = (label, ok, detail = '') => {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail ? ` (${detail})` : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const compose = (argv) => execFileSync('docker', ['compose', '-p', 'aegis-local', '--env-file', join(root, '.env.local'), ...argv],
  { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

// Runs a command inside a workload container as a UID and returns its exit code and output (never throws).
function run(uid, service, args) {
  try {
    const userArgs = uid === null ? [] : ['-u', String(uid)];
    const out = compose(['exec', '-T', ...userArgs, service, ...args]);
    return { code: 0, out };
  } catch (err) {
    return { code: err.status ?? 1, out: `${err.stdout ?? ''}${err.stderr ?? ''}` };
  }
}
const probe = (uid, service, url, expected) => run(uid, service, ['/app/aegis-workload', 'probe', url, expected]);
const logs = (service) => compose(['logs', '--no-log-prefix', service]);
const containerStartedAt = (service) => {
  const id = compose(['ps', '-q', service]).trim();
  return execFileSync('docker', ['inspect', '--format', '{{.State.StartedAt}}', id], { encoding: 'utf8' }).trim();
};
const svidSerials = (service) => [...logs(service).matchAll(/"msg":"svid_observed".*?"expires_at":"([^"]+)"/g)].map((m) => m[1]);
const noKeyMaterial = (text) => !/PRIVATE KEY|BEGIN CERTIFICATE|-----BEGIN/.test(text);

async function waitFor(predicate, timeoutMs, stepMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await sleep(stepMs);
  }
  return false;
}

// ---- 1. Infrastructure and identity issuance
console.log('\n-- 1. SPIRE infrastructure and issued identities');
const health = run(null, 'spire-server', ['/opt/spire/bin/spire-server', 'healthcheck']);
check('spire-server is healthy', health.code === 0);
const agents = compose(['exec', '-T', 'spire-server', '/opt/spire/bin/spire-server', 'agent', 'list']);
const attested = (agents.match(/SPIFFE ID\s*:/g) ?? []).length;
check('four workload agents are attested by x509pop', attested >= 4, `${attested} attested agents`);
for (const [role, spiffeId] of Object.entries(ID)) {
  const service = role;
  const svid = logs(service).split('\n').filter((l) => l.includes('"msg":"svid_observed"')).pop() ?? '';
  check(`${role} received an SVID from the Workload API`, svid.includes(`"spiffe_id":"${spiffeId}"`), spiffeId);
}
check('no key material appears in workload or agent logs',
  ['orchestrator', 'triage', 'retrieval', 'reviewer', 'spire-agent-triage'].every((s) => noKeyMaterial(logs(s))));

// ---- 2. Explicit peer authorisation: allowed pairs succeed, unauthorised pairs are refused at the handshake
console.log('\n-- 2. Mutual TLS with explicit peer authorisation');
const matrix = [
  ['orchestrator calls triage (allowed)', 1001, 'orchestrator', `https://triage:8443`, ID.triage, 0],
  ['orchestrator calls retrieval (allowed)', 1001, 'orchestrator', `https://retrieval:8443`, ID.retrieval, 0],
  ['orchestrator calls reviewer (allowed)', 1001, 'orchestrator', `https://reviewer:8443`, ID.reviewer, 0],
  ['triage calls retrieval (allowed)', 1002, 'triage', `https://retrieval:8443`, ID.retrieval, 0],
  ['reviewer calls triage (not authorised)', 1004, 'reviewer', `https://triage:8443`, ID.triage, 3],
  ['retrieval calls orchestrator (not authorised)', 1003, 'retrieval', `https://orchestrator:8443`, ID.orchestrator, 3],
  ['orchestrator calls triage expecting retrieval identity (wrong peer)', 1001, 'orchestrator', `https://triage:8443`, ID.retrieval, 3],
];
for (const [label, uid, service, url, expected, want] of matrix) {
  const r = probe(uid, service, url, expected);
  const ok = r.code === want && noKeyMaterial(r.out);
  check(label, ok, `exit ${r.code}`);
}
// The refusals must come from the server's own authorisation, not only from the client. Check the server log names the refused peer.
const triageLog = logs('triage');
check('triage logged the refusal of reviewer by identity', triageLog.includes(`"peer_spiffe_id":"${ID.reviewer}"`) && triageLog.includes('peer_refused'));

// ---- 3. Adversarial: same UID, other containers, unregistered identities
console.log('\n-- 3. Adversarial identity and isolation tests');
const unregistered = run(1002, 'probe', ['/app/aegis-workload', 'probe', 'https://triage:8443', ID.triage]);
check('unregistered container with the same UID (1002) is refused an SVID', unregistered.code === 1 && /no_identity/.test(unregistered.out));
const intruder = run(1002, 'intruder', ['/app/aegis-workload', 'probe', 'https://triage:8443', ID.triage]);
check('same-UID container handed triage\'s socket volume is refused (different PID namespace)', intruder.code === 1 && /no_identity/.test(intruder.out));
const rootInTriage = run(0, 'triage', ['/app/aegis-workload', 'probe', 'https://retrieval:8443', ID.retrieval]);
check('a different UID inside the triage container (root) is refused an SVID', rootInTriage.code === 1);
const otherUidInTriage = run(1003, 'triage', ['/app/aegis-workload', 'probe', 'https://retrieval:8443', ID.retrieval]);
check('a different UID (1003) inside the triage container is refused an SVID', otherUidInTriage.code === 1);
// Known boundary, asserted so it stays documented: the container is the workload boundary. A second process running as the same UID
// inside triage's own container shares triage's identity. This is why each workload must run in its own container.
const sameUidInTriage = run(1002, 'triage', ['/app/aegis-workload', 'probe', 'https://retrieval:8443', ID.retrieval]);
check('KNOWN LIMIT: a second same-UID process inside triage\'s container receives triage\'s identity', sameUidInTriage.code === 0,
  'documented: container, not process, is the boundary');
check('the unregistered probe node cannot call the mesh', probe(1002, 'probe', 'https://retrieval:8443', ID.retrieval).code !== 0);
check('impersonation: a certificate claiming triage\'s SPIFFE ID but signed by an untrusted CA is refused',
  probe(1001, 'orchestrator', 'https://rogue:8443', ID.triage).code === 3 && /unknown authority/.test(probe(1001, 'orchestrator', 'https://rogue:8443', ID.triage).out));

// ---- 4. Rotation without restart
console.log('\n-- 4. Automatic SVID renewal without restart');
const startedBefore = containerStartedAt('triage');
const serialsBefore = svidSerials('triage').length;
const rotated = await waitFor(async () => svidSerials('triage').length > serialsBefore, 6 * 60_000, 15_000);
check('triage observes a renewed SVID before the first one expires', rotated, `${svidSerials('triage').length} observed`);
check('triage was not restarted to load the new SVID', containerStartedAt('triage') === startedBefore);
const afterRotation = probe(1002, 'triage', 'https://retrieval:8443', ID.retrieval);
check('mTLS keeps working on the renewed SVID', afterRotation.code === 0);

if (outage) {
  // ---- 5. Outage and recovery. Each step is bounded and restores the service before the check ends.
  console.log('\n-- 5. Dependency outage, expiry and recovery');
  compose(['stop', 'spire-server']);
  // Workloads keep their current SVID until it expires; agents hold their last state.
  const during = probe(1001, 'orchestrator', 'https://triage:8443', ID.triage);
  check('mTLS continues while spire-server is down, on the cached SVID', during.code === 0);
  // Wait past the expiry of the SVID that was current when the server stopped (5-minute lifetime).
  await sleep(5.5 * 60_000);
  const expired = probe(1001, 'orchestrator', 'https://triage:8443', ID.triage);
  check('an expired SVID is refused (no SVID is trusted past its expiry)', expired.code !== 0);
  compose(['start', 'spire-server']);
  const recovered = await waitFor(async () => probe(1001, 'orchestrator', 'https://triage:8443', ID.triage).code === 0, 4 * 60_000, 10_000);
  check('mTLS recovers after spire-server returns and renews SVIDs', recovered);

  compose(['stop', 'spire-agent-triage']);
  await sleep(10_000);
  const agentDown = probe(1001, 'orchestrator', 'https://triage:8443', ID.triage);
  check('triage keeps serving on its cached SVID while its agent is down', agentDown.code === 0);
  compose(['start', 'spire-agent-triage']);
  const agentBack = await waitFor(async () => probe(1001, 'orchestrator', 'https://triage:8443', ID.triage).code === 0, 3 * 60_000, 10_000);
  check('triage recovers after its agent restarts', agentBack);
}

const passed = results.every(Boolean);
console.log(passed ? '\nSPIRE workload identity acceptance passed.' : '\nSPIRE workload identity acceptance FAILED.');
process.exit(passed ? 0 : 1);

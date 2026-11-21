#!/usr/bin/env node
// Opt-in acceptance for the local Compose stack: start, reconcile identities, verify, authentication acceptance, and the real browser
// lifecycle suite. It creates only local, generated secrets and touches only the compose project "aegis-local". It needs no cloud
// credentials and it does not run on pull requests. The workflow that calls it is manual (workflow_dispatch).
// Use `--down` to stop the stack afterwards. Volumes are never removed.
import { spawnSync } from 'node:child_process';

const steps = [
  ['local secrets', ['node', ['scripts/local-stack.mjs', 'init']]],
  ['start stack', ['node', ['scripts/local-stack.mjs', 'up']]],
  ['identity reconciliation', ['node', ['scripts/keycloak-setup.mjs']]],
  ['health and readiness', ['node', ['scripts/local-stack.mjs', 'verify']]],
  ['authentication acceptance', ['node', ['scripts/e2e-auth.mjs']]],
  ['telemetry (traces, metrics, correlation, allowlist)', ['node', ['scripts/telemetry-check.mjs']]],
  ['SPIRE workload identity (real SVIDs, explicit mTLS, adversarial and rotation)', ['node', ['scripts/spire-acceptance.mjs']]],
  ['browser lifecycle (production build)', ['npm', ['run', 'test:e2e', '-w', '@aegis/web']], { AEGIS_STACK_E2E: '1' }],
];

let failed = null;
for (const [label, [command, args], extraEnv] of steps) {
  console.log(`\n== ${label}`);
  const result = spawnSync(command, args, { stdio: 'inherit', env: { ...process.env, ...(extraEnv ?? {}) } });
  if (result.status !== 0) { failed = label; break; }
}

if (process.argv.includes('--down')) spawnSync('node', ['scripts/local-stack.mjs', 'down'], { stdio: 'inherit' });

console.log(failed ? `\nStack acceptance FAILED at: ${failed}` : '\nStack acceptance passed.');
process.exit(failed ? 1 : 0);

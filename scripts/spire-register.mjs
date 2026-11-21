#!/usr/bin/env node
// Creates the SPIRE registration entries in infra/spire/registrations.json (P3). Idempotent and fail-closed:
//   - an entry that exists with the same parent and selector is left alone;
//   - an entry that exists with a different parent or selector is reported and NOT overwritten (fix it deliberately).
// Registration names the parent by the node credential's CN, read from the server's attested-agent list. No entry is created for an
// unregistered workload, and nothing here reads an identity from a workload or from its environment.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const registrations = JSON.parse(readFileSync(join(root, 'infra/spire/registrations.json'), 'utf8'));

const compose = (argv) => execFileSync('docker', ['compose', '-p', 'aegis-local', '--env-file', join(root, '.env.local'), ...argv],
  { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const server = (argv) => compose(['exec', '-T', 'spire-server', '/opt/spire/bin/spire-server', ...argv]);

// Parent SPIFFE ID of a node: the attested agent whose x509pop CN selector matches the node credential.
function agentIdForNode(node) {
  const out = server(['agent', 'list', '-selector', `x509pop:subject:cn:node-${node}`]);
  const match = /SPIFFE ID\s*:\s*(\S+)/.exec(out);
  if (!match) throw new Error(`no attested agent for node "${node}" (is spire-agent-${node} running?)`);
  return match[1];
}

function existingEntry(spiffeId) {
  const out = server(['entry', 'show', '-spiffeID', spiffeId]);
  if (/Found 0 entries/.test(out) || out.trim() === '') return null;
  return {
    parent: /Parent ID\s*:\s*(\S+)/.exec(out)?.[1] ?? null,
    selectors: [...out.matchAll(/Selector\s*:\s*(\S+)/g)].map((m) => m[1]),
  };
}

let failures = 0;
for (const entry of registrations.entries) {
  const parent = agentIdForNode(entry.node);
  const selector = `unix:uid:${entry.uid}`;
  const current = existingEntry(entry.spiffeId);
  if (current) {
    const same = current.parent === parent && current.selectors.length === 1 && current.selectors[0] === selector;
    console.log(`${same ? 'exists' : 'CONFLICT'} ${entry.spiffeId} (parent ${entry.node} agent, ${selector})`);
    if (!same) failures += 1;
    continue;
  }
  server(['entry', 'create', '-parentID', parent, '-spiffeID', entry.spiffeId, '-selector', selector,
    '-x509SVIDTTL', String(entry.x509SvidTtlSeconds)]);
  console.log(`created ${entry.spiffeId} (parent ${entry.node} agent, ${selector})`);
}
if (failures) {
  console.error(`${failures} entr${failures === 1 ? 'y' : 'ies'} conflict with the registration file. Not overwritten.`);
  process.exit(1);
}

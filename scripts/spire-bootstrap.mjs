#!/usr/bin/env node
// SPIRE bootstrap for the local AEGIS stack (P3).
//
// Creates the x509pop certificate authority and one node credential per agent, outside the repository. Starts the SPIRE server, then
// writes its trust bundle to the same directory so agents can verify the server. Idempotent: existing material is never overwritten
// unless --rotate-node <name> is given.
//
//   node scripts/spire-bootstrap.mjs                 create missing material, start spire-server, write bundle.pem
//   node scripts/spire-bootstrap.mjs --refresh-bundle re-read the server bundle (after the server data volume is recreated)
//   node scripts/spire-bootstrap.mjs --rotate-node triage   replace one node credential (see docs/SPIRE-WORKLOAD-IDENTITY.md)
//
// Private keys are written with mode 0600 and never printed. Only paths, subjects and expiry dates are printed.
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, appendFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const refreshBundle = args.includes('--refresh-bundle');
const rotateIndex = args.indexOf('--rotate-node');
const rotateNode = rotateIndex >= 0 ? args[rotateIndex + 1] : null;

// Node credentials. "probe" exists only for acceptance tests (it is not registered and must be refused).
const NODES = ['orchestrator', 'triage', 'retrieval', 'reviewer', 'probe'];

const defaultDir = platform() === 'darwin'
  ? join(homedir(), 'Library', 'Application Support', 'aegis-local-secrets', 'spire')
  : join(homedir(), '.aegis-local-secrets', 'spire');
const secretsDir = resolve(process.env.AEGIS_SPIRE_SECRETS_DIR || defaultDir);

if (secretsDir === root || secretsDir.startsWith(root + '/')) {
  console.error('Refusing: the SPIRE secrets directory must be outside the repository.');
  process.exit(1);
}

const openssl = (argv, options = {}) => execFileSync('openssl', argv, { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', ...options });
const compose = (argv, options = {}) => execFileSync('docker', ['compose', '-p', 'aegis-local', '--env-file', join(root, '.env.local'), ...argv],
  { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', ...options });

function ensureDir() {
  mkdirSync(secretsDir, { recursive: true, mode: 0o700 });
  chmodSync(secretsDir, 0o700);
}

function ensureEnvPointer() {
  const envPath = join(root, '.env.local');
  const content = existsSync(envPath) ? readFileSync(envPath, 'utf8') : '';
  if (/^AEGIS_SPIRE_SECRETS_DIR=/m.test(content)) return;
  appendFileSync(envPath, `AEGIS_SPIRE_SECRETS_DIR=${secretsDir}\n`, { mode: 0o600 });
}

function createCa() {
  if (existsSync(join(secretsDir, 'ca.crt')) && existsSync(join(secretsDir, 'ca.key'))) return false;
  openssl(['ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', join(secretsDir, 'ca.key')]);
  openssl(['req', '-x509', '-new', '-key', join(secretsDir, 'ca.key'), '-sha256', '-days', '730', '-subj', '/CN=AEGIS local SPIRE x509pop CA',
    '-addext', 'basicConstraints=critical,CA:TRUE,pathlen:0', '-addext', 'keyUsage=critical,keyCertSign,cRLSign', '-out', join(secretsDir, 'ca.crt')]);
  chmodSync(join(secretsDir, 'ca.key'), 0o600);
  chmodSync(join(secretsDir, 'ca.crt'), 0o644);
  return true;
}

function createNode(name) {
  const key = join(secretsDir, `node-${name}.key`);
  const crt = join(secretsDir, `node-${name}.crt`);
  if (existsSync(key) && existsSync(crt)) return false;
  const csr = join(secretsDir, `node-${name}.csr`);
  const ext = join(secretsDir, `node-${name}.ext`);
  openssl(['ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', key]);
  openssl(['req', '-new', '-key', key, '-subj', `/CN=node-${name}`, '-out', csr]);
  writeFileSync(ext, 'basicConstraints=CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=clientAuth\nsubjectKeyIdentifier=hash\nauthorityKeyIdentifier=keyid\n');
  openssl(['x509', '-req', '-in', csr, '-CA', join(secretsDir, 'ca.crt'), '-CAkey', join(secretsDir, 'ca.key'), '-CAcreateserial', '-days', '90',
    '-sha256', '-extfile', ext, '-out', crt]);
  unlinkSync(csr);
  unlinkSync(ext);
  chmodSync(key, 0o600);
  chmodSync(crt, 0o644);
  return true;
}

function describeCert(path) {
  const out = openssl(['x509', '-in', path, '-noout', '-subject', '-enddate']).trim().split('\n');
  return out.map((l) => l.replace(/^subject=\s*/, 'subject ').replace(/^notAfter=/, 'expires ')).join(', ');
}

function startServerAndWriteBundle() {
  compose(['up', '-d', 'spire-server'], { stdio: 'inherit' });
  const deadline = Date.now() + 120_000;
  for (;;) {
    try {
      compose(['exec', '-T', 'spire-server', '/opt/spire/bin/spire-server', 'healthcheck']);
      break;
    } catch {
      if (Date.now() > deadline) throw new Error('spire-server did not become healthy within 120 s');
      execFileSync('sleep', ['2']);
    }
  }
  const bundle = compose(['exec', '-T', 'spire-server', '/opt/spire/bin/spire-server', 'bundle', 'show', '-format', 'pem']);
  if (!bundle.includes('BEGIN CERTIFICATE')) throw new Error('spire-server returned no trust bundle');
  writeFileSync(join(secretsDir, 'bundle.pem'), bundle, { mode: 0o644 });
  return bundle;
}

ensureDir();
ensureEnvPointer();

if (rotateNode) {
  if (!NODES.includes(rotateNode)) throw new Error(`unknown node "${rotateNode}"`);
  unlinkSync(join(secretsDir, `node-${rotateNode}.key`));
  unlinkSync(join(secretsDir, `node-${rotateNode}.crt`));
  // A rotated node has a new certificate, so its agent must be re-attested with the new credential (see the runbook).
}

const createdCa = createCa();
const createdNodes = NODES.filter((n) => createNode(n));

// Always re-read the bundle from the running server, so it matches the trust domain the server actually uses.
startServerAndWriteBundle();
if (createdCa || createdNodes.length || refreshBundle || rotateNode) console.log('material changed in this run');

console.log(`SPIRE secrets directory: ${secretsDir} (outside the repository, mode 0700)`);
console.log(`CA: ${describeCert(join(secretsDir, 'ca.crt'))}`);
for (const n of NODES) console.log(`node ${n}: ${describeCert(join(secretsDir, `node-${n}.crt`))}`);
console.log(`trust bundle: ${join(secretsDir, 'bundle.pem')}`);

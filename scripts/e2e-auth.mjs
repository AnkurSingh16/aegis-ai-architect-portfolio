#!/usr/bin/env node
// End-to-end authentication acceptance for the local stack. It uses real Keycloak tokens (RS256, signed by the realm's keys) and sends them
// to the API container over HTTP. Nothing here is mocked. Secrets are read from .env.local and never printed.
// Usage: node scripts/e2e-auth.mjs            (checks, including expiry)
//        node scripts/e2e-auth.mjs --rotate   (also rotates the realm signing key and measures the effect)
import { createSign, generateKeyPairSync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const env = Object.fromEntries(readFileSync(join(root, '.env.local'), 'utf8').split('\n')
  .map((line) => /^([A-Z0-9_]+)=(.*)$/.exec(line.trim())).filter(Boolean).map((m) => [m[1], m[2]]));
const KC = `http://127.0.0.1:${env.AEGIS_PORT_KEYCLOAK ?? 8180}/realms/aegis`;
const KC_ADMIN = `http://127.0.0.1:${env.AEGIS_PORT_KEYCLOAK ?? 8180}`;
const API = `http://127.0.0.1:${env.AEGIS_PORT_API ?? 4110}`;
const NORTH = '10000000-0000-4000-8000-000000000001';
const SOUTH = '20000000-0000-4000-8000-000000000002';
const rotate = process.argv.includes('--rotate');

const results = [];
const check = (label, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail ? ` (${detail})` : ''}`); };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function token(client, secret, username, scope = 'openid read:cases') {
  const body = new URLSearchParams({ grant_type: 'password', client_id: client, username, password: env.AEGIS_KC_TEST_USER_PASSWORD, scope });
  if (secret) body.set('client_secret', secret);
  const response = await fetch(`${KC}/protocol/openid-connect/token`, { method: 'POST', body });
  const data = await response.json();
  if (!data.access_token) throw new Error(`token request failed for ${username}: HTTP ${response.status}`);
  return data.access_token;
}

async function listCases(tenant, bearer) {
  const headers = bearer ? { authorization: `Bearer ${bearer}` } : {};
  const response = await fetch(`${API}/api/tenants/${tenant}/cases`, { headers, signal: AbortSignal.timeout(8000) });
  return response.status;
}

const b64url = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
const claims = (jwt) => JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString('utf8'));

async function main() {
  const testSecret = env.AEGIS_KC_TEST_CLIENT_SECRET;
  const alice = await token('aegis-test-client', testSecret, 'alice.north');
  const carol = await token('aegis-test-client', testSecret, 'carol.south');
  const bob = await token('aegis-test-client', testSecret, 'bob.unlinked');
  const noScope = await token('aegis-test-client', testSecret, 'alice.north', 'openid');

  const aliceClaims = claims(alice);
  check('token issued by the local realm with the expected issuer and audience',
    aliceClaims.iss === 'http://localhost:8180/realms/aegis' && aliceClaims.aud === 'aegis-api' && typeof aliceClaims.sub === 'string');
  check('token carries the read:cases scope', aliceClaims.scope.split(' ').includes('read:cases'));

  check('member of the tenant with read scope is served', (await listCases(NORTH, alice)) === 200);
  check('member presenting a token for another tenant is refused', (await listCases(SOUTH, alice)) === 403);
  check('a valid user with no membership is refused', (await listCases(NORTH, bob)) === 403);
  check('a user of another tenant is refused on this tenant', (await listCases(NORTH, carol)) === 403);
  check('a valid token without the read:cases scope is refused', (await listCases(NORTH, noScope)) === 403);
  check('anonymous caller is refused', (await listCases(NORTH)) === 401);

  // Tampering: payload changed with the original signature. The verifier must reject it.
  const [h, , s] = alice.split('.');
  const tampered = `${h}.${b64url({ ...aliceClaims, sub: claims(bob).sub })}.${s}`;
  check('tampered payload (subject swapped, signature kept) is refused', (await listCases(NORTH, tampered)) === 401);

  // alg=none: an unsigned token must never be accepted.
  const unsigned = `${b64url({ alg: 'none', typ: 'JWT' })}.${b64url(aliceClaims)}.`;
  check('unsigned alg=none token is refused', (await listCases(NORTH, unsigned)) === 401);

  // Forged: correct issuer, audience and subject, but signed by a key the realm never published.
  const forgerKeys = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const signer = createSign('RSA-SHA256');
  const forgedHead = b64url({ alg: 'RS256', typ: 'JWT', kid: 'forged' });
  const forgedBody = b64url({ ...aliceClaims, exp: Math.floor(Date.now() / 1000) + 300 });
  signer.update(`${forgedHead}.${forgedBody}`);
  const forged = `${forgedHead}.${forgedBody}.${signer.sign(forgerKeys.privateKey, 'base64url')}`;
  check('token signed by an unpublished key is refused', (await listCases(NORTH, forged)) === 401);

  // Expiry: a client with a three-second lifetime. Valid immediately, refused after expiry.
  const short = await token('aegis-short-lived-client', env.AEGIS_KC_SHORT_CLIENT_SECRET, 'alice.north');
  const shortClaims = claims(short);
  check('short-lived token has a three-second lifetime', shortClaims.exp - shortClaims.iat <= 3, `${shortClaims.exp - shortClaims.iat}s`);
  check('short-lived token is accepted before expiry', (await listCases(NORTH, short)) === 200);
  await sleep(Math.max(0, (shortClaims.exp + 2) * 1000 - Date.now()));
  check('short-lived token is refused after expiry', (await listCases(NORTH, short)) === 401);

  if (rotate) await rotateKey(alice);

  const passed = results.every(Boolean);
  console.log(passed ? 'Authentication acceptance passed.' : 'Authentication acceptance failed.');
  return passed ? 0 : 1;
}

async function adminToken() {
  const body = new URLSearchParams({ grant_type: 'password', client_id: 'admin-cli', username: 'aegis-admin', password: env.AEGIS_KEYCLOAK_ADMIN_PASSWORD });
  return (await (await fetch(`${KC_ADMIN}/realms/master/protocol/openid-connect/token`, { method: 'POST', body })).json()).access_token;
}

// Signing-key rotation and emergency retirement.
// Policy (docs/KEY-ROTATION-POLICY.md): a new key is added with a higher priority and becomes the signer. The old key is retired by
// disabling it (enabled=false), which removes it from the published key set. Setting only active=false is NOT retirement: Keycloak keeps
// passive keys in the set so that older tokens still verify. The verifier caches the key set for 60 s, so a disabled key is refused within
// that window. The check identifies the key that signed the old token by its kid, then measures refusal.
function headerOf(jwt) {
  return JSON.parse(Buffer.from(jwt.split('.')[0], 'base64url').toString('utf8'));
}

async function rotateKey(oldAliceToken) {
  const oldKid = headerOf(oldAliceToken).kid;
  const at = await adminToken();
  const h = { authorization: `Bearer ${at}`, 'content-type': 'application/json' };
  const realmId = (await (await fetch(`${KC_ADMIN}/admin/realms/aegis`, { headers: h })).json()).id;
  const created = await fetch(`${KC_ADMIN}/admin/realms/aegis/components`, { method: 'POST', headers: h, body: JSON.stringify({
    name: `aegis-rotated-rsa-${Date.now()}`, providerId: 'rsa-generated', providerType: 'org.keycloak.keys.KeyProvider', parentId: realmId,
    config: { priority: ['200'], enabled: ['true'], active: ['true'], keySize: ['2048'], algorithm: ['RS256'] } }) });
  check('new signing key created in the realm', created.status === 201);

  const fresh = await token('aegis-test-client', env.AEGIS_KC_TEST_CLIENT_SECRET, 'alice.north');
  const started = Date.now();
  let acceptedAt = null;
  for (let attempt = 0; attempt < 45 && acceptedAt === null; attempt += 1) {
    if ((await listCases(NORTH, fresh)) === 200) acceptedAt = Date.now() - started;
    else await sleep(2000);
  }
  check('token signed by the new key is accepted after JWKS refresh', acceptedAt !== null,
    acceptedAt === null ? 'not within 90s' : `after ${Math.round(acceptedAt / 1000)}s`);

  // Find the component that owns the old token's kid, using the realm key listing (kid -> component id).
  const listing = await (await fetch(`${KC_ADMIN}/admin/realms/aegis/keys`, { headers: h })).json();
  const owner = (listing.keys ?? []).find((key) => key.kid === oldKid);
  check('the key that signed the old token is identified in the realm', owner !== undefined, owner ? `status ${owner.status}` : 'not found');
  if (!owner) return;
  const component = await (await fetch(`${KC_ADMIN}/admin/realms/aegis/components/${owner.providerId}`, { headers: h })).json();
  component.config.enabled = ['false'];
  component.config.active = ['false'];
  const disabled = await fetch(`${KC_ADMIN}/admin/realms/aegis/components/${owner.providerId}`, { method: 'PUT', headers: h, body: JSON.stringify(component) });
  check('old key disabled (emergency retirement)', disabled.ok);

  const retiredAt = Date.now();
  let refusedAt = null;
  for (let attempt = 0; attempt < 45 && refusedAt === null; attempt += 1) {
    if ((await listCases(NORTH, oldAliceToken)) === 401) refusedAt = Date.now() - retiredAt;
    else await sleep(2000);
  }
  check('token signed by the retired key is refused within the 60 s cache policy', refusedAt !== null,
    refusedAt === null ? 'still accepted after 90s' : `refused after ${Math.round(refusedAt / 1000)}s`);
}

process.exit(await main());

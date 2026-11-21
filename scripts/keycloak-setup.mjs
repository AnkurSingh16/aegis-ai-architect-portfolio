#!/usr/bin/env node
// Idempotent local identity setup for the AEGIS Keycloak realm. Creates synthetic users, sets the local test client secrets and user
// passwords from .env.local, and writes tenant memberships keyed by the Keycloak subject. It never prints a secret, and it only
// touches the local realm "aegis" in this project's Keycloak. It makes no change to any other identity provider.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const env = Object.fromEntries(readFileSync(join(root, '.env.local'), 'utf8').split('\n')
  .map((line) => /^([A-Z0-9_]+)=(.*)$/.exec(line.trim())).filter(Boolean).map((m) => [m[1], m[2]]));
const KC = `http://127.0.0.1:${env.AEGIS_PORT_KEYCLOAK ?? 8180}`;
const ISSUER = 'http://localhost:8180/realms/aegis';
const TENANT_NORTH = '10000000-0000-4000-8000-000000000001';
const TENANT_SOUTH = '20000000-0000-4000-8000-000000000002';

const USERS = [
  { username: 'alice.north', first: 'Alice', last: 'Synthetic', tenant: TENANT_NORTH, role: 'reader' },
  { username: 'olivia.north', first: 'Olivia', last: 'Synthetic', tenant: TENANT_NORTH, role: 'operator' },
  { username: 'carol.south', first: 'Carol', last: 'Synthetic', tenant: TENANT_SOUTH, role: 'reader' },
  // Bob is a verified, real identity with no membership in any tenant. Used to prove membership is enforced.
  { username: 'bob.unlinked', first: 'Bob', last: 'Synthetic', tenant: null, role: null },
];

async function json(response) {
  const text = await response.text();
  if (!response.ok && response.status !== 409) throw new Error(`HTTP ${response.status} from ${response.url.split('?')[0]}`);
  return text ? JSON.parse(text) : undefined;
}

async function adminToken() {
  const body = new URLSearchParams({ grant_type: 'password', client_id: 'admin-cli', username: 'aegis-admin',
    password: env.AEGIS_KEYCLOAK_ADMIN_PASSWORD });
  const response = await fetch(`${KC}/realms/master/protocol/openid-connect/token`, { method: 'POST', body });
  return (await json(response)).access_token;
}

async function admin(token, path, init = {}) {
  return fetch(`${KC}/admin/realms/aegis${path}`, { ...init, headers: { authorization: `Bearer ${token}`,
    'content-type': 'application/json', ...(init.headers ?? {}) } });
}

async function setClientSecret(token, clientId, secret) {
  const found = await json(await admin(token, `/clients?clientId=${encodeURIComponent(clientId)}`));
  if (!found.length) throw new Error(`client missing: ${clientId}`);
  const full = await json(await admin(token, `/clients/${found[0].id}`));
  const response = await admin(token, `/clients/${found[0].id}`, { method: 'PUT', body: JSON.stringify({ ...full, secret }) });
  if (!response.ok) throw new Error(`client update failed: ${clientId}`);
  return clientId;
}

// The `basic` scope maps the subject into `sub`, which the API verifier requires. Imported clients do not receive it automatically.
// Adds the scopes declared in the realm file that the realm lacks (SKIP keeps existing definitions unchanged), then assigns defaults.
async function ensureScopes(token) {
  const realm = JSON.parse(readFileSync(join(root, 'infra', 'keycloak', 'aegis-realm.json'), 'utf8'));
  const existing = (await json(await admin(token, '/client-scopes'))).map((scope) => scope.name);
  for (const scope of realm.clientScopes) {
    if (existing.includes(scope.name)) continue;
    const created = await admin(token, '/client-scopes', { method: 'POST', body: JSON.stringify(scope) });
    if (created.status !== 201) throw new Error(`client scope create failed: ${scope.name}`);
  }
}

// Assigns each default scope the realm file declares for this client (the subject and audience scopes).
async function ensureDefaultScopes(token, clientUuid, names) {
  const scopes = await json(await admin(token, '/client-scopes'));
  for (const name of names) {
    const scope = scopes.find((s) => s.name === name);
    if (!scope) throw new Error(`client scope missing: ${name}`);
    const response = await admin(token, `/clients/${clientUuid}/default-client-scopes/${scope.id}`, { method: 'PUT' });
    if (!response.ok && response.status !== 409) throw new Error(`default scope failed: ${name}`);
  }
}

async function clientUuid(token, clientId) {
  const found = await json(await admin(token, `/clients?clientId=${encodeURIComponent(clientId)}`));
  if (!found.length) throw new Error(`client missing: ${clientId}`);
  return found[0].id;
}

// Converges a client to the realm file: attributes, redirect URIs, web origins and optional scopes. Values not declared in the file
// are left alone except for the keys the file declares. Existing realm data is never reset or deleted.
async function reconcileClient(token, declared) {
  const uuid = await clientUuid(token, declared.clientId);
  const current = await json(await admin(token, `/clients/${uuid}`));
  const attributes = { ...(current.attributes ?? {}), ...(declared.attributes ?? {}) };
  const body = { ...current, attributes, redirectUris: declared.redirectUris ?? current.redirectUris,
    webOrigins: declared.webOrigins ?? current.webOrigins };
  const put = await admin(token, `/clients/${uuid}`, { method: 'PUT', body: JSON.stringify(body) });
  if (!put.ok) throw new Error(`client reconcile failed: ${declared.clientId}`);
  const scopes = await json(await admin(token, '/client-scopes'));
  for (const name of declared.optionalClientScopes ?? []) {
    const scope = scopes.find((s) => s.name === name);
    if (!scope) throw new Error(`client scope missing: ${name}`);
    const response = await admin(token, `/clients/${uuid}/optional-client-scopes/${scope.id}`, { method: 'PUT' });
    if (!response.ok && response.status !== 409) throw new Error(`optional scope failed: ${name}`);
  }
}

// Brings a client scope's protocol mappers to exactly the declared set: creates missing ones, updates changed ones, and removes mappers
// the file does not declare (this is how a duplicate audience mapper is removed).
async function reconcileScopeMappers(token, declared) {
  const scopes = await json(await admin(token, '/client-scopes'));
  const scope = scopes.find((s) => s.name === declared.name);
  if (!scope) throw new Error(`client scope missing: ${declared.name}`);
  const live = await json(await admin(token, `/client-scopes/${scope.id}/protocol-mappers/models`));
  const wanted = declared.protocolMappers ?? [];
  for (const mapper of live) {
    if (!wanted.some((w) => w.name === mapper.name)) {
      const removed = await admin(token, `/client-scopes/${scope.id}/protocol-mappers/models/${mapper.id}`, { method: 'DELETE' });
      if (!removed.ok) throw new Error(`mapper removal failed: ${declared.name}`);
    }
  }
  for (const want of wanted) {
    const match = live.find((m) => m.name === want.name);
    if (!match) {
      const created = await admin(token, `/client-scopes/${scope.id}/protocol-mappers/models`, { method: 'POST', body: JSON.stringify(want) });
      if (created.status !== 201) throw new Error(`mapper create failed: ${want.name}`);
    } else {
      const body = { ...match, config: { ...(match.config ?? {}), ...want.config }, protocolMapper: want.protocolMapper };
      const updated = await admin(token, `/client-scopes/${scope.id}/protocol-mappers/models/${match.id}`, { method: 'PUT', body: JSON.stringify(body) });
      if (!updated.ok) throw new Error(`mapper update failed: ${want.name}`);
    }
  }
}

async function ensureUser(token, user) {
  let created = await admin(token, '/users', { method: 'POST', body: JSON.stringify({
    username: user.username, enabled: true, emailVerified: true, firstName: user.first, lastName: user.last,
    email: `${user.username.replace('.', '-')}@synthetic.test`, requiredActions: [] }) });
  if (created.status !== 201 && created.status !== 409) throw new Error(`user create failed: ${user.username}`);
  const found = await json(await admin(token, `/users?username=${encodeURIComponent(user.username)}&exact=true`));
  const id = found[0].id;
  const reset = await admin(token, `/users/${id}/reset-password`, { method: 'PUT', body: JSON.stringify({
    type: 'password', value: env.AEGIS_KC_TEST_USER_PASSWORD, temporary: false }) });
  if (!reset.ok) throw new Error(`password set failed: ${user.username}`);
  return id;
}

function writeMemberships(rows) {
  const values = rows.map((r) => `('${ISSUER}', '${r.subject}', '${r.tenant}', '${r.role}')`).join(',\n');
  const sql = `
INSERT INTO aegis.tenants (id, name) VALUES ('${TENANT_NORTH}', 'Synthetic North'), ('${TENANT_SOUTH}', 'Synthetic South')
  ON CONFLICT (id) DO NOTHING;
${rows.length ? `INSERT INTO aegis.memberships (issuer, subject, tenant_id, role) VALUES\n${values}\n  ON CONFLICT (issuer, subject, tenant_id) DO UPDATE SET role = EXCLUDED.role;` : ''}
`;
  const result = spawnSync('docker', ['compose', '-p', 'aegis-local', '--env-file', join(root, '.env.local'), 'exec', '-T',
    'postgres', 'psql', '-U', 'aegis_admin', '-d', 'aegis_local', '-v', 'ON_ERROR_STOP=1', '-q', '-f', '-'],
  { input: sql, encoding: 'utf8' });
  if (result.status !== 0) throw new Error('membership write failed');
}

const token = await adminToken();
await ensureScopes(token);
const realm = JSON.parse(readFileSync(join(root, 'infra', 'keycloak', 'aegis-realm.json'), 'utf8'));
for (const client of realm.clients) await ensureDefaultScopes(token, await clientUuid(token, client.clientId), client.defaultClientScopes);
for (const scope of realm.clientScopes) await reconcileScopeMappers(token, scope);
for (const client of realm.clients) await reconcileClient(token, client);
await setClientSecret(token, 'aegis-test-client', env.AEGIS_KC_TEST_CLIENT_SECRET);
await setClientSecret(token, 'aegis-short-lived-client', env.AEGIS_KC_SHORT_CLIENT_SECRET);
const subjects = {};
for (const user of USERS) subjects[user.username] = await ensureUser(token, user);
writeMemberships(USERS.filter((u) => u.tenant).map((u) => ({ subject: subjects[u.username], tenant: u.tenant, role: u.role })));
console.log(`Keycloak identity setup complete: ${USERS.length} synthetic users, ${USERS.filter((u) => u.tenant).length} memberships. Secrets not shown.`);
export { subjects };

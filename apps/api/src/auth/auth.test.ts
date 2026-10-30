import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWTVerifyGetKey, type JWTPayload } from 'jose';
import type { Pool, PoolClient } from 'pg';
import { createApp } from '../app.js';
import { resolveAuthConfig, validateIssuer } from './config.js';
import { createTokenVerifier, requireScope, type VerifiedPrincipal } from './token.js';
import { withAuthenticatedTransaction } from './transaction.js';
import { parseMembershipCommand, provisionMembership } from './memberships.js';

const issuer = 'https://synthetic.auth0.example/';
const audience = 'https://aegis.synthetic.example/api';
const tenant = '10000000-0000-4000-8000-000000000001';
const id = '12345678-1234-4234-8234-123456789abc';
const config = { issuer, audience, databaseUrl: 'postgres://localhost/aegis_test' };
let keys: Awaited<ReturnType<typeof generateKeyPair>>;
let otherKeys: Awaited<ReturnType<typeof generateKeyPair>>;
let resolver: JWTVerifyGetKey;
const apps: Array<ReturnType<typeof createApp>> = [];
beforeAll(async () => {
  keys = await generateKeyPair('RS256');
  otherKeys = await generateKeyPair('RS256');
  resolver = createLocalJWKSet({ keys: [{ ...await exportJWK(keys.publicKey), kid: 'primary', alg: 'RS256' }] });
});
beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'info').mockImplementation(() => {});
});
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
function claims(overrides: JWTPayload = {}): JWTPayload {
  return { iss: issuer, aud: audience, sub: 'synthetic|reader', exp: Math.floor(Date.now() / 1000) + 300,
    scope: 'read:cases write:cases', ...overrides };
}
async function sign(payload = claims(), options: { key?: typeof keys.privateKey; kid?: string; header?: Record<string, string> } = {}) {
  return new SignJWT(payload).setProtectedHeader({ alg: 'RS256', kid: options.kid ?? 'primary', ...options.header })
    .sign(options.key ?? keys.privateKey);
}
async function bearer(payload = claims()) { return `Bearer ${await sign(payload)}`; }
function unsigned(payload: JWTPayload) {
  return `${Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url')}.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.x`;
}

describe('authentication configuration', () => {
  it('accepts explicit local membership administration for an allowlisted fixture', () => {
    const env = { AUTH0_ISSUER: issuer, AEGIS_MEMBER_SUBJECT: 'synthetic|member', AEGIS_MEMBER_FIXTURE: 'north', AEGIS_MEMBER_ROLE: 'reader' };
    expect(parseMembershipCommand(['grant'], env)).toEqual({ action: 'grant', issuer, subject: 'synthetic|member', tenantId: tenant, role: 'reader' });
    expect(parseMembershipCommand(['revoke'], env)).toEqual({ action: 'revoke', issuer, subject: 'synthetic|member', tenantId: tenant });
    for (const input of [[], ['unknown'], ['grant', '--tenant', tenant]]) expect(() => parseMembershipCommand(input, env)).toThrow();
    for (const overrides of [{ AEGIS_MEMBER_SUBJECT: '' }, { AEGIS_MEMBER_SUBJECT: ' invalid ' }, { AEGIS_MEMBER_SUBJECT: 'bad\nsubject' },
      { AEGIS_MEMBER_SUBJECT: 'x'.repeat(256) }, { AEGIS_MEMBER_ROLE: 'admin' }, { AEGIS_MEMBER_FIXTURE: tenant }]) {
      expect(() => parseMembershipCommand(['grant'], { ...env, ...overrides })).toThrow();
    }
  });
  it('refuses membership provisioning and its CLI in production before connecting', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    await expect(provisionMembership(config.databaseUrl, { action: 'revoke', issuer, subject: 'synthetic|member', tenantId: tenant }))
      .rejects.toThrow('local-development');
    const original = process.exitCode;
    try {
      await import('./membership-cli.js');
      expect(process.exitCode).toBe(1);
      expect(console.error).toHaveBeenCalledWith(expect.stringContaining('membership.change_failed'));
    } finally { process.exitCode = original; }
  });
  it('disables protected routes only when both auth settings are absent', () => {
    expect(resolveAuthConfig({ DATABASE_URL: 'postgres://localhost/aegis_test' })).toBeUndefined();
    expect(resolveAuthConfig({ AUTH0_ISSUER: issuer, AUTH0_AUDIENCE: audience, DATABASE_URL: config.databaseUrl })).toEqual(config);
  });
  it.each([
    { AUTH0_ISSUER: issuer }, { AUTH0_AUDIENCE: audience },
    { AUTH0_ISSUER: '', AUTH0_AUDIENCE: audience, DATABASE_URL: config.databaseUrl },
    { AUTH0_ISSUER: issuer, AUTH0_AUDIENCE: '', DATABASE_URL: config.databaseUrl },
    { AUTH0_ISSUER: issuer, AUTH0_AUDIENCE: audience },
    { AUTH0_ISSUER: issuer, AUTH0_AUDIENCE: ' bad audience ', DATABASE_URL: config.databaseUrl },
    { AUTH0_ISSUER: issuer, AUTH0_AUDIENCE: 'x'.repeat(256), DATABASE_URL: config.databaseUrl },
  ])('fails closed for partial or malformed settings %j', (env) => expect(() => resolveAuthConfig(env)).toThrow());
  it.each(['bad', 'http://issuer.example/', 'https://issuer.example', 'https://issuer.example/path/',
    'https://user:password@issuer.example/', 'https://issuer.example:444/', 'https://issuer.example/?jwks=other',
    'https://issuer.example/#other', 'https://localhost/', 'https://auth.localhost/', 'https://127.0.0.1/', 'https://[::1]/'])(
    'rejects unsafe or noncanonical issuer %s', (value) => expect(() => validateIssuer(value)).toThrow());
  it('never permits test dependency injection outside tests', () => {
    vi.stubEnv('NODE_ENV', 'production');
    expect(() => createTokenVerifier(config, resolver)).toThrow('Test key resolver');
    expect(() => createApp({ authConfig: config, testDependencies: {} })).toThrow('Test dependencies');
  });
});

describe('JWT validation with generated local signing keys', () => {
  it('accepts a signed API access token and parses exact space-delimited scopes', async () => {
    const principal = await createTokenVerifier(config, resolver)(await bearer());
    expect(principal).toEqual({ issuer, subject: 'synthetic|reader', scopes: new Set(['read:cases', 'write:cases']) });
    expect(() => requireScope(principal, 'read:cases')).not.toThrow();
  });
  it.each([undefined, '', 'Basic secret', 'Bearer', 'Bearer a.b', 'Bearer a.b.c extra', 'Bearer  a.b.c',
    'Bearer a.b.c\n', `Bearer ${'a'.repeat(8193)}`])('rejects malformed or oversized Authorization header', async (header) => {
    await expect(createTokenVerifier(config, resolver)(header)).rejects.toMatchObject({ status: 401, message: 'Authentication required.' });
  });
  it.each([
    { iss: 'https://other-issuer.example/' }, { aud: 'auth0-spa-client-id' }, { aud: 'other-api' },
    { exp: 1 }, { exp: 'tomorrow' }, { nbf: Math.floor(Date.now() / 1000) + 3600 },
    { sub: '' }, { sub: 'x'.repeat(256) }, { sub: 'synthetic\nsubject' }, { sub: 42 },
  ])('rejects incorrect or malformed claims %j', async (overrides) => {
    await expect(createTokenVerifier(config, resolver)(await bearer(claims(overrides as JWTPayload))))
      .rejects.toMatchObject({ status: 401 });
  });
  it.each(['iss', 'aud', 'sub', 'exp'])('requires %s', async (claim) => {
    const payload = claims(); delete payload[claim];
    await expect(createTokenVerifier(config, resolver)(await bearer(payload))).rejects.toMatchObject({ status: 401 });
  });
  it('rejects unsigned tokens, HMAC confusion, bad signatures and unknown key IDs', async () => {
    const verify = createTokenVerifier(config, resolver);
    const hmac = await new SignJWT(claims()).setProtectedHeader({ alg: 'HS256', kid: 'primary' }).sign(new Uint8Array(32));
    for (const token of [unsigned(claims()), hmac, await sign(claims(), { key: otherKeys.privateKey }), await sign(claims(), { kid: 'unknown' })]) {
      await expect(verify(`Bearer ${token}`)).rejects.toMatchObject({ status: 401 });
    }
  });
  it('ignores token-controlled jku and x5u and still requires the configured signing key', async () => {
    const keyLookup = vi.fn(resolver);
    const verify = createTokenVerifier(config, keyLookup);
    const header = { jku: 'https://attacker.invalid/jwks', x5u: 'https://attacker.invalid/cert' };
    expect(await verify(`Bearer ${await sign(claims(), { header })}`)).toMatchObject({ issuer });
    await expect(verify(`Bearer ${await sign(claims(), { header, key: otherKeys.privateKey })}`)).rejects.toMatchObject({ status: 401 });
    expect(keyLookup).toHaveBeenCalledTimes(2);
  });
  it('fails closed when JWKS resolution is unavailable and accepts a correctly rotated configured key', async () => {
    const unavailable: JWTVerifyGetKey = async () => { throw new Error('INTERNAL-JWKS-SECRET'); };
    await expect(createTokenVerifier(config, unavailable)(await bearer())).rejects.toMatchObject({ status: 401, message: 'Authentication required.' });
    const rotated = createLocalJWKSet({ keys: [{ ...await exportJWK(otherKeys.publicKey), kid: 'rotated', alg: 'RS256' }] });
    const verify = createTokenVerifier(config, rotated);
    await expect(verify(await bearer())).rejects.toMatchObject({ status: 401 });
    expect(await verify(`Bearer ${await sign(claims(), { key: otherKeys.privateKey, kid: 'rotated' })}`)).toMatchObject({ issuer });
  });
  it('fetches only the issuer-derived JWKS URL and fails closed when its endpoint is unavailable', async () => {
    const jwks = { keys: [{ ...await exportJWK(keys.publicKey), kid: 'primary', alg: 'RS256' }] };
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify(jwks), { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetch);
    const malicious = await sign(claims(), { header: { jku: 'https://attacker.invalid/keys', x5u: 'https://attacker.invalid/cert' } });
    expect(await createTokenVerifier(config)(`Bearer ${malicious}`)).toMatchObject({ issuer });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(String(fetch.mock.calls[0][0])).toBe(`${issuer}.well-known/jwks.json`);
    fetch.mockRejectedValue(new Error('SECRET-JWKS-OUTAGE'));
    await expect(createTokenVerifier(config)(await bearer())).rejects.toMatchObject({ status: 401, message: 'Authentication required.' });
    expect(fetch.mock.calls.every(([url]) => String(url) === `${issuer}.well-known/jwks.json`)).toBe(true);
  });
  it.each([['read:cases'], { permissions: ['read:cases'] }, '', 'read:cases\twrite:cases', 'read:cases  write:cases'].map((scope) => ({ scope })))(
    'rejects malformed scope claim $scope', async ({ scope }) => {
      await expect(createTokenVerifier(config, resolver)(await bearer(claims({ scope })))).rejects.toMatchObject({ status: 401 });
    });
  it('does not treat substring scopes, permissions or role claims as token authorization', async () => {
    for (const payload of [claims({ scope: 'prefixread:cases read:cases:extra', permissions: ['read:cases'], roles: ['operator'] }),
      claims({ scope: undefined, permissions: ['read:cases'], roles: ['operator'] })]) {
      const principal = await createTokenVerifier(config, resolver)(await bearer(payload));
      expect(() => requireScope(principal, 'read:cases')).toThrow('Access denied.');
    }
  });
});

function fakePool(role = 'operator') {
  const stored = { id, tenant_id: tenant, synthetic_case_id: 'SYNTHETIC-LOGIN-001', status: 'open' };
  const query = vi.fn(async (sql: string) => ({ rows: sql.includes('FROM aegis.memberships') ? [{ role }]
    : sql.includes('SELECT *') || sql.includes('RETURNING') ? [stored] : [] }));
  const release = vi.fn();
  const client = { query, release } as unknown as PoolClient;
  const connect = vi.fn().mockResolvedValue(client);
  const end = vi.fn().mockResolvedValue(undefined);
  const verifyQuery = vi.fn().mockResolvedValue({ rows: [{ safe: true }] });
  return { pool: { connect, end, query: verifyQuery } as unknown as Pool, query, release, connect, end, verifyQuery };
}
const principal: VerifiedPrincipal = { issuer, subject: 'synthetic|reader', scopes: new Set(['read:cases', 'write:cases']) };
function appFor(pool: Pool) { const app = createApp({ authConfig: config, testDependencies: { keyResolver: resolver, pool } }); apps.push(app); return app; }

describe('authorization transaction boundaries', () => {
  it('resolves membership and sets tenant on one repeatable-read transaction', async () => {
    const { pool, query, release } = fakePool();
    expect(await withAuthenticatedTransaction(pool, principal, tenant, 'read:cases', async () => 'safe')).toBe('safe');
    expect(query.mock.calls[0][0]).toBe('BEGIN ISOLATION LEVEL REPEATABLE READ');
    expect(query.mock.calls[1]).toEqual([expect.stringContaining("'authenticated'"), [issuer, principal.subject]]);
    expect(query.mock.calls[2]).toEqual([expect.stringContaining('SELECT role'), [issuer, principal.subject, tenant]]);
    expect(query.mock.calls[3]).toEqual([expect.stringContaining("'aegis.tenant_id'"), [tenant]]);
    expect(query).toHaveBeenLastCalledWith('COMMIT'); expect(release).toHaveBeenCalledWith(false);
  });
  it('rejects insufficient scope before acquiring a database connection', async () => {
    const { pool, connect } = fakePool();
    await expect(withAuthenticatedTransaction(pool, { ...principal, scopes: new Set() }, tenant, 'read:cases', async () => null))
      .rejects.toMatchObject({ status: 403 });
    expect(connect).not.toHaveBeenCalled();
  });
  it.each(['reader', 'unknown', ''])('rejects write access for membership role %s and rolls back', async (role) => {
    const { pool, query, release } = fakePool(role);
    await expect(withAuthenticatedTransaction(pool, principal, tenant, 'write:cases', async () => null)).rejects.toMatchObject({ status: 403 });
    expect(query).toHaveBeenLastCalledWith('ROLLBACK'); expect(release).toHaveBeenCalledWith(false);
  });
  it('destroys a connection if rollback fails', async () => {
    const { pool, query, release } = fakePool();
    query.mockImplementation(async (sql: string) => { if (sql === 'ROLLBACK') throw new Error('broken'); return { rows: [] }; });
    await expect(withAuthenticatedTransaction(pool, principal, tenant, 'read:cases', async () => null)).rejects.toMatchObject({ status: 403 });
    expect(release).toHaveBeenCalledWith(true);
  });
});

describe('protected HTTP routes', () => {
  it('requires authentication before parsing input and keeps health and synthetic triage available', async () => {
    const { pool, connect } = fakePool(); const app = appFor(pool);
    const reply = await app.inject({ method: 'POST', url: `/api/tenants/${tenant}/cases`, payload: { tenantId: 'forged' } });
    expect(reply.statusCode).toBe(401); expect(reply.headers['www-authenticate']).toBe('Bearer');
    expect(connect).not.toHaveBeenCalled();
    expect((await app.inject('/api/health')).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: '/api/demo/triage', payload: { caseId: 'SYNTHETIC-LOGIN-001' } })).statusCode).toBe(200);
  });
  it('supports scoped list, read, synthetic create and status update', async () => {
    const { pool } = fakePool(); const app = appFor(pool); const authorization = await bearer();
    for (const request of [
      { method: 'GET' as const, url: `/api/tenants/${tenant}/cases` },
      { method: 'GET' as const, url: `/api/tenants/${tenant}/cases/${id}` },
      { method: 'POST' as const, url: `/api/tenants/${tenant}/cases`, payload: { syntheticCaseId: 'SYNTHETIC-LOGIN-001' } },
      { method: 'PATCH' as const, url: `/api/tenants/${tenant}/cases/${id}/status`, payload: { status: 'resolved' } },
    ]) {
      const reply = await app.inject({ ...request, headers: { authorization } });
      expect(reply.statusCode).toBe(request.method === 'POST' ? 201 : 200);
    }
  });
  it('intersects token permissions with reader membership and does not accept claim role elevation', async () => {
    const { pool } = fakePool('reader'); const app = appFor(pool);
    const authorization = await bearer(claims({ roles: ['operator'], permissions: ['write:cases'] }));
    expect((await app.inject({ url: `/api/tenants/${tenant}/cases`, headers: { authorization } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: `/api/tenants/${tenant}/cases`, headers: { authorization }, payload: { syntheticCaseId: 'SYNTHETIC-LOGIN-001' } })).statusCode).toBe(403);
  });
  it('returns neutral404 for an inaccessible case within an authorized tenant', async () => {
    const { pool, query } = fakePool();
    query.mockImplementation(async (sql: string) => ({ rows: sql.includes('FROM aegis.memberships') ? [{ role: 'operator' }] : [] }));
    const reply = await appFor(pool).inject({ url: `/api/tenants/${tenant}/cases/${id}`, headers: { authorization: await bearer() } });
    expect(reply.statusCode).toBe(404); expect(reply.json()).toEqual({ error: 'Case not found.' });
  });
  it.each([
    { method: 'GET' as const, path: 'not-a-uuid/cases' },
    { method: 'GET' as const, path: `${tenant}/cases?tenantId=forged` },
    { method: 'POST' as const, path: `${tenant}/cases`, payload: { syntheticCaseId: 'SYNTHETIC-LOGIN-001', tenantId: 'forged' } },
    { method: 'POST' as const, path: `${tenant}/cases`, payload: { syntheticCaseId: 'customer-input' } },
    { method: 'PATCH' as const, path: `${tenant}/cases/${id}/status`, payload: { status: 'invalid' } },
    { method: 'PATCH' as const, path: `${tenant}/cases/${id}/status`, payload: { status: 'resolved', role: 'operator' } },
  ])('rejects malformed and authorization-related extra input', async ({ method, path, ...body }) => {
    const { pool, connect } = fakePool();
    const reply = await appFor(pool).inject({ method, url: `/api/tenants/${path}`, ...body, headers: { authorization: await bearer() } });
    expect(reply.statusCode).toBe(400); expect(connect).not.toHaveBeenCalled();
  });
  it('sanitizes DB failures and logs without exposing tokens, subject or raw database errors', async () => {
    const { pool, connect } = fakePool(); connect.mockRejectedValue(new Error('postgres://SECRET:password@localhost/db RAW-DATABASE-DETAIL'));
    const authorization = await bearer();
    const reply = await appFor(pool).inject({ url: `/api/tenants/${tenant}/cases`, headers: { authorization, 'x-tenant-id': 'forged' } });
    expect(reply.statusCode).toBe(503); expect(reply.json()).toEqual({ error: 'Case storage is unavailable. Please retry.' });
    const output = `${reply.body} ${JSON.stringify(vi.mocked(console.error).mock.calls)} ${JSON.stringify(vi.mocked(console.info).mock.calls)}`;
    for (const secret of [authorization, 'SECRET', 'password', 'RAW-DATABASE-DETAIL', principal.subject]) expect(output).not.toContain(secret);
  });
  it('fails startup for unsafe runtime roles and closes the pool', async () => {
    const { pool, verifyQuery, end } = fakePool(); verifyQuery.mockResolvedValue({ rows: [{ safe: false }] });
    await expect(appFor(pool).ready()).rejects.toThrow('initialization failed'); expect(end).toHaveBeenCalled();
  });
});

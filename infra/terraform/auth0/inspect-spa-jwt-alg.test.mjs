import test from 'node:test';
import assert from 'node:assert/strict';
import { assertInspectionInvocation, classifySpaJwtAlgorithm, inspectSpaJwtAlgorithm } from './inspect-spa-jwt-alg.mjs';

const syntheticSecrets = {
  auth0Domain: 'dev-example.auth0.com',
  auth0ClientId: 'synthetic-management-client-id',
  auth0ClientSecret: 'SYNTHETIC_MANAGEMENT_SECRET_DO_NOT_EMIT',
  spaClientId: 'synthetic-spa-client-id',
};
const syntheticToken = 'SYNTHETIC_BEARER_TOKEN_DO_NOT_EMIT';
const secretSentinel = 'SYNTHETIC_CLIENT_SECRET_DO_NOT_EMIT';

test('requires a normal terminal invocation without arguments or automation context', () => {
  assert.doesNotThrow(() => assertInspectionInvocation({ argv: ['node', 'inspect.mjs'], stdinIsTTY: true, stdoutIsTTY: true, env: {} }));
  for (const overrides of [
    { argv: ['node', 'inspect.mjs', '--scope', 'read:clients'] },
    { stdinIsTTY: false },
    { stdoutIsTTY: false },
    { env: { CI: 'true' } },
    { env: { CODEX_THREAD_ID: 'synthetic' } },
  ]) {
    assert.throws(() => assertInspectionInvocation({ argv: ['node', 'inspect.mjs'], stdinIsTTY: true, stdoutIsTTY: true, env: {}, ...overrides }), /normal interactive terminal/);
  }
});

function response(status, document) {
  return { status, ok: status >= 200 && status < 300, json: async () => document };
}

for (const [label, client, expected] of [
  ['missing jwt configuration', { client_id: syntheticSecrets.spaClientId }, 'missing'],
  ['missing algorithm property', { jwt_configuration: {}, client_id: syntheticSecrets.spaClientId }, 'missing'],
  ['malformed jwt configuration', { jwt_configuration: null }, 'unexpected'],
  ['empty algorithm', { jwt_configuration: { alg: '' } }, 'empty'],
  ['HS256', { jwt_configuration: { alg: 'HS256' } }, 'HS256'],
  ['RS256', { jwt_configuration: { alg: 'RS256' } }, 'RS256'],
  ['unexpected value', { jwt_configuration: { alg: 'SYNTHETIC-OTHER' } }, 'unexpected'],
  ['unexpected non-string value', { jwt_configuration: { alg: 42 } }, 'unexpected'],
]) {
  test(`classifies Auth0 jwt_configuration.alg safely when ${label}`, () => {
    assert.equal(classifySpaJwtAlgorithm(client), expected);
  });
}

test('requests only the already-authorized read:clients permission and returns only the algorithm classification', async () => {
  const requests = [];
  const result = await inspectSpaJwtAlgorithm({
    loadConfiguration: async () => syntheticSecrets,
    isInteractive: () => true,
    fetchImpl: async (url, options) => {
      requests.push({ url: String(url), options });
      if (requests.length === 1) return response(200, { access_token: syntheticToken, scope: 'read:clients' });
      return response(200, { client_id: syntheticSecrets.spaClientId,
        jwt_configuration: { alg: 'RS256' }, client_secret: secretSentinel });
    },
  });
  assert.deepEqual(result, { status: 'verified', classification: 'RS256' });
  assert.equal(requests.length, 2);
  assert.equal(requests[0].url, 'https://dev-example.auth0.com/oauth/token');
  const tokenRequest = JSON.parse(requests[0].options.body);
  assert.equal(tokenRequest.audience, 'https://dev-example.auth0.com/api/v2/');
  assert.equal(tokenRequest.scope, 'read:clients');
  assert.equal(Object.keys(tokenRequest).sort().join(','), 'audience,client_id,client_secret,grant_type,scope');
  assert.equal(requests[0].options.redirect, 'error');
  assert.equal(requests[1].url, 'https://dev-example.auth0.com/api/v2/clients/synthetic-spa-client-id');
  assert.equal(requests[1].options.method, 'GET');
  assert.equal(requests[1].options.redirect, 'error');
  assert.equal(requests[1].options.headers.authorization, `Bearer ${syntheticToken}`);
  assert.equal(JSON.stringify(result).includes(syntheticToken), false);
  assert.equal(JSON.stringify(result).includes(secretSentinel), false);
  assert.equal(JSON.stringify(result).includes(syntheticSecrets.auth0ClientSecret), false);
});

test('does not make requests when the operator is not in an interactive terminal', async () => {
  let requests = 0;
  await assert.rejects(inspectSpaJwtAlgorithm({
    loadConfiguration: async () => syntheticSecrets,
    fetchImpl: async () => { requests += 1; },
    isInteractive: () => false,
  }), /interactive terminal/);
  assert.equal(requests, 0);
});

test('reports a missing read permission without inspecting or disclosing an error response', async () => {
  const results = [response(200, { access_token: syntheticToken }), response(403, { message: secretSentinel })];
  let index = 0;
  const result = await inspectSpaJwtAlgorithm({ loadConfiguration: async () => syntheticSecrets,
    isInteractive: () => true, fetchImpl: async () => results[index++] });
  assert.deepEqual(result, { status: 'read-permission-unavailable', classification: null });
  assert.equal(JSON.stringify(result).includes(secretSentinel), false);
  assert.equal(JSON.stringify(result).includes(syntheticToken), false);
});

test('fails closed when a response belongs to a different SPA or credentials are unavailable', async () => {
  const mismatch = await inspectSpaJwtAlgorithm({ loadConfiguration: async () => syntheticSecrets,
    isInteractive: () => true, fetchImpl: async (_url, options) => options.method === 'POST'
      ? response(200, { access_token: syntheticToken })
      : response(200, { client_id: 'foreign-id', jwt_configuration: { alg: 'RS256' } }) });
  assert.deepEqual(mismatch, { status: 'spa-identity-unverified', classification: null });
  const denied = await inspectSpaJwtAlgorithm({ loadConfiguration: async () => syntheticSecrets,
    isInteractive: () => true, fetchImpl: async () => response(401, { error: secretSentinel }) });
  assert.deepEqual(denied, { status: 'read-permission-unavailable', classification: null });
  assert.equal(JSON.stringify([mismatch, denied]).includes(secretSentinel), false);
});

test('operator cancellation aborts the request and reports only a generic error', async () => {
  const controller = new AbortController();
  const pending = inspectSpaJwtAlgorithm({ loadConfiguration: async () => syntheticSecrets, signal: controller.signal,
    isInteractive: () => true,
    fetchImpl: async (_url, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(new Error(secretSentinel)), { once: true });
    }) });
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort();
  await assert.rejects(pending, /Read-only Auth0 request failed or timed out/);
});

test('operator cancellation after response headers also interrupts body parsing', async () => {
  const controller = new AbortController();
  const pending = inspectSpaJwtAlgorithm({ loadConfiguration: async () => syntheticSecrets, signal: controller.signal,
    isInteractive: () => true,
    fetchImpl: async () => ({ status: 200, ok: true, json: () => new Promise(() => {}) }) });
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort();
  await assert.rejects(pending, /Read-only Auth0 request failed or timed out/);
});

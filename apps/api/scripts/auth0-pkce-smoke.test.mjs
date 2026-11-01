import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { afterEach, describe, it } from 'node:test';
import { runSmoke, scenarios, validateScenario, validateSmokeConfig } from './auth0-pkce-smoke.mjs';

const config = Object.freeze({ issuer: 'https://aegis-dev.example.auth0.com/',
  audience: 'https://aegis-ai.local/api', clientId: 'aegisSpaClient_123' });
const servers = new Set();

function apiServer(status) {
  const requests = [];
  const server = createServer((request, response) => {
    requests.push({ url: request.url, authorization: request.headers.authorization });
    response.writeHead(status, { 'content-type': 'application/json' }).end('{}');
  });
  servers.add(server);
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    const address = server.address();
    resolve({ origin: `http://127.0.0.1:${address.port}`, requests,
      close: () => new Promise((done) => server.close(() => { servers.delete(server); done(); })) });
  }));
}

afterEach(async () => {
  for (const server of servers) await new Promise((resolve) => server.close(() => resolve()));
  servers.clear();
});

function tokenFetch(api, tokenResponse = { access_token: 'synthetic_access_token_marker', token_type: 'Bearer' }, options = {}) {
  const tokenCalls = [];
  const fetchImpl = async (input, init = {}) => {
    const url = new URL(input);
    if (url.pathname.endsWith('/oauth/token')) {
      tokenCalls.push({ url, init });
      if (options.tokenFetch) return options.tokenFetch(input, init);
      return new Response(JSON.stringify(tokenResponse), { status: options.tokenStatus ?? 200,
        headers: { 'content-type': 'application/json' } });
    }
    if (options.apiFetch) return options.apiFetch(input, init);
    return fetch(input, init);
  };
  return { fetchImpl, tokenCalls };
}

async function runWithCallback({ scenarioName = 'authorized-north', apiStatus = 200, callback = 'valid',
  tokenResponse, tokenStatus, timeout = 500, requestTimeout = 100, tokenFetch: tokenFetchOption, apiFetch,
  onAuthorization, output = [] } = {}) {
  const api = await apiServer(apiStatus);
  const mocked = tokenFetch(api, tokenResponse, { tokenStatus, tokenFetch: tokenFetchOption, apiFetch });
  const write = (event) => {
    output.push(event.value);
    if (event.type === 'authorization-url') {
      onAuthorization?.(event.value);
      if (!onAuthorization) queueMicrotask(() => void sendCallback(event.value, callback));
    }
  };
  try {
    const result = await runSmoke({ config, scenarioName, apiOrigin: api.origin, listenPort: 0,
      callbackTimeout: timeout, requestTimeout, fetchImpl: mocked.fetchImpl, output: write });
    return { result, output, api, mocked };
  } catch (error) { return { error, output, api, mocked }; }
  finally { await api.close(); }
}

async function sendCallback(authorizeValue, mode = 'valid') {
  const authorize = new URL(authorizeValue);
  const callbackUrl = new URL(authorize.searchParams.get('redirect_uri'));
  const params = new URLSearchParams();
  params.set('state', mode === 'wrong-state' ? 'wrong_state_marker' : authorize.searchParams.get('state'));
  if (mode === 'duplicate-state') params.append('state', authorize.searchParams.get('state'));
  if (mode !== 'missing-code') params.set('code', mode === 'empty-code' ? '' : 'synthetic_code_marker');
  if (mode === 'duplicate-code') params.append('code', 'another_code_marker');
  if (mode === 'wrong-issuer') params.set('iss', 'https://attacker.example/');
  const url = `${callbackUrl}?${params}`;
  return fetch(url, { redirect: 'error' });
}

describe('Auth0 PKCE smoke configuration', () => {
  it('requires canonical HTTPS issuer, API audience and SPA ID without consuming database settings', () => {
    const env = { AUTH0_ISSUER: config.issuer, AUTH0_AUDIENCE: config.audience,
      AUTH0_SPA_CLIENT_ID: config.clientId };
    Object.defineProperty(env, 'DATABASE_URL', { get() { throw new Error('database setting must not be read'); } });
    assert.deepEqual(validateSmokeConfig({ AUTH0_ISSUER: config.issuer, AUTH0_AUDIENCE: config.audience,
      AUTH0_SPA_CLIENT_ID: config.clientId }), config);
    assert.deepEqual(validateSmokeConfig(env), config);
    for (const patch of [
      { AUTH0_ISSUER: 'http://aegis-dev.example.auth0.com/' },
      { AUTH0_ISSUER: 'https://other.example.auth0.com/path/' },
      { AUTH0_ISSUER: 'https://user@aegis-dev.example.auth0.com/' },
      { AUTH0_AUDIENCE: '' }, { AUTH0_AUDIENCE: 'https://aegis api' },
      { AUTH0_SPA_CLIENT_ID: '' }, { AUTH0_SPA_CLIENT_ID: 'client id with spaces' },
    ]) assert.throws(() => validateSmokeConfig({ AUTH0_ISSUER: config.issuer, AUTH0_AUDIENCE: config.audience,
      AUTH0_SPA_CLIENT_ID: config.clientId, ...patch }));
  });

  it('rejects unknown scenarios', () => assert.throws(() => validateScenario('anything-else')));
});

describe('Auth0 Authorization Code + PKCE smoke flow', () => {
  it('performs PKCE S256 and verifies the authorized North reader response without exposing code or token', async () => {
    const run = await runWithCallback();
    assert.deepEqual(run.result, { scenario: 'authorized-north', expectedStatus: 200, actualStatus: 200, passed: true });
    const authorize = new URL(run.output.find((line) => line.startsWith('https://')));
    const tokenRequest = JSON.parse(run.mocked.tokenCalls[0].init.body);
    assert.equal(authorize.searchParams.get('code_challenge_method'), 'S256');
    assert.equal(authorize.searchParams.get('code_challenge'), createHash('sha256').update(tokenRequest.code_verifier).digest('base64url'));
    assert.equal(tokenRequest.code, 'synthetic_code_marker');
    assert.equal(tokenRequest.redirect_uri, authorize.searchParams.get('redirect_uri'));
    assert.equal(run.api.requests[0].url, `/api/tenants/${scenarios['authorized-north'].tenant === 'north' ? '10000000-0000-4000-8000-000000000001' : ''}/cases`);
    assert.match(run.api.requests[0].authorization, /^Bearer synthetic_access_token_marker$/);
    const output = run.output.join('\n');
    for (const secret of ['synthetic_code_marker', 'synthetic_access_token_marker', tokenRequest.code_verifier]) assert.equal(output.includes(secret), false);
  });

  it('rejects a state mismatch and never exchanges the code', async () => {
    const run = await runWithCallback({ callback: 'wrong-state' });
    assert.match(run.error.message, /callback validation failed/);
    assert.equal(run.mocked.tokenCalls.length, 0);
    assert.equal(run.output.join('\n').includes('synthetic_code_marker'), false);
  });

  it('rejects absent and empty authorization codes without token exchange', async () => {
    for (const callback of ['missing-code', 'empty-code']) {
      const run = await runWithCallback({ callback });
      assert.match(run.error.message, /callback validation failed/);
      assert.equal(run.mocked.tokenCalls.length, 0);
    }
  });

  it('rejects duplicate state/code and a mismatched optional issuer before token exchange', async () => {
    for (const callback of ['duplicate-state', 'duplicate-code', 'wrong-issuer']) {
      const run = await runWithCallback({ callback });
      assert.match(run.error.message, /callback validation failed/);
      assert.equal(run.mocked.tokenCalls.length, 0);
      assert.doesNotMatch(run.output.join('\n'), /synthetic_code_marker|another_code_marker/);
    }
  });

  it('handles OAuth rejection with generic output and redacts callback code, response body and tokens', async () => {
    const markers = ['synthetic_code_marker', 'fake_access_token_marker', 'fake_refresh_token_marker', 'auth0_error_body_marker'];
    const run = await runWithCallback({ tokenStatus: 400,
      tokenResponse: { error: 'invalid_grant', error_description: markers.join(' ') } });
    assert.match(run.error.message, /token exchange failed/);
    const output = run.output.join('\n');
    for (const marker of markers) assert.equal(output.includes(marker), false);
  });

  it('enforces expected denials for missing membership, insufficient scope and cross-tenant selection', async () => {
    for (const scenarioName of ['no-membership', 'insufficient-scope', 'cross-tenant']) {
      const run = await runWithCallback({ scenarioName, apiStatus: 403 });
      assert.equal(run.result.passed, true);
      assert.equal(run.result.actualStatus, 403);
      const authorize = new URL(run.output.find((line) => line.startsWith('https://')));
      assert.equal(authorize.searchParams.get('scope'), scenarios[scenarioName].scope);
      const tenant = scenarios[scenarioName].tenant === 'south'
        ? '20000000-0000-4000-8000-000000000002' : '10000000-0000-4000-8000-000000000001';
      assert.equal(run.api.requests[0].url, `/api/tenants/${tenant}/cases`);
      assert.doesNotMatch(run.output.join('\n'), /synthetic_access_token_marker|synthetic_code_marker/);
    }
  });

  it('checks the missing-bearer scenario without OAuth or Authorization header', async () => {
    const run = await runWithCallback({ scenarioName: 'missing-bearer', apiStatus: 401 });
    assert.equal(run.result.passed, true);
    assert.equal(run.mocked.tokenCalls.length, 0);
    assert.equal(run.api.requests[0].authorization, undefined);
  });

  it('rejects wrong HTTP results rather than treating any non-2xx response as success', async () => {
    const run = await runWithCallback({ scenarioName: 'authorized-north', apiStatus: 403 });
    assert.deepEqual(run.result, { scenario: 'authorized-north', expectedStatus: 200, actualStatus: 403, passed: false });
  });

  it('times out the local callback and releases the port', async () => {
    const api = await apiServer(200);
    const port = await new Promise((resolve, reject) => {
      const probe = createServer(); probe.once('error', reject); probe.listen(0, '127.0.0.1', () => {
        const value = probe.address().port; probe.close(() => resolve(value));
      });
    });
    try {
      await assert.rejects(runSmoke({ config, scenarioName: 'authorized-north', apiOrigin: api.origin,
        listenPort: port, callbackTimeout: 30, requestTimeout: 100, fetchImpl: tokenFetch(api).fetchImpl,
        output: () => {} }), /timed out/);
      const probe = createServer();
      await new Promise((resolve, reject) => { probe.once('error', reject); probe.listen(port, '127.0.0.1', resolve); });
      await new Promise((resolve) => probe.close(resolve));
    } finally { await api.close(); }
  });

  it('bounds token and protected API requests', async () => {
    const api = await apiServer(200);
    const hangs = (_url, { signal }) => new Promise((_, reject) => {
      signal.addEventListener('abort', () => reject(new Error('sensitive fake network details')), { once: true });
    });
    try {
      await assert.rejects(runSmoke({ config, scenarioName: 'authorized-north', apiOrigin: api.origin,
        listenPort: 0, callbackTimeout: 300, requestTimeout: 25, fetchImpl: hangs,
        output: (event) => { if (event.type === 'authorization-url') queueMicrotask(() => void sendCallback(event.value)); } }), /token exchange failed/);

      let apiRequested = false;
      const tokenThenHangAtApi = async (input, init) => {
        if (new URL(input).pathname.endsWith('/oauth/token')) {
          return new Response(JSON.stringify({ access_token: 'synthetic_access_token_marker', token_type: 'Bearer' }));
        }
        apiRequested = true;
        return hangs(input, init);
      };
      await assert.rejects(runSmoke({ config, scenarioName: 'authorized-north', apiOrigin: api.origin,
        listenPort: 0, callbackTimeout: 300, requestTimeout: 25, fetchImpl: tokenThenHangAtApi,
        output: (event) => { if (event.type === 'authorization-url') queueMicrotask(() => void sendCallback(event.value)); } }), /bounded .* request failed/);
      assert.equal(apiRequested, true);
    } finally { await api.close(); }
  });

  it('cancels on SIGINT signal and closes the callback listener', async () => {
    const api = await apiServer(200);
    const controller = new AbortController();
    let callbackPort;
    const pending = runSmoke({ config, scenarioName: 'authorized-north', apiOrigin: api.origin,
      listenPort: 0, callbackTimeout: 500, requestTimeout: 50, signal: controller.signal,
      fetchImpl: tokenFetch(api).fetchImpl,
      output: (event) => {
        if (event.type === 'authorization-url') {
          callbackPort = new URL(new URL(event.value).searchParams.get('redirect_uri')).port;
          controller.abort();
        }
      } });
    try {
      await assert.rejects(pending, /cancelled/);
      const probe = createServer();
      await new Promise((resolve, reject) => { probe.once('error', reject); probe.listen(Number(callbackPort), '127.0.0.1', resolve); });
      await new Promise((resolve) => probe.close(resolve));
    }
    finally { await api.close(); }
  });

  it('allows only one callback to exchange a code', async () => {
    const api = await apiServer(200);
    let releaseToken;
    const deferredToken = new Promise((resolve) => { releaseToken = resolve; });
    let tokenCalls = 0;
    const fetchImpl = async (input, init) => {
      if (new URL(input).pathname.endsWith('/oauth/token')) { tokenCalls++; await deferredToken; return new Response(JSON.stringify({ access_token: 'single_use_token_marker', token_type: 'Bearer' })); }
      return fetch(input, init);
    };
    let secondCallback;
    const pending = runSmoke({ config, scenarioName: 'authorized-north', apiOrigin: api.origin,
      listenPort: 0, callbackTimeout: 500, requestTimeout: 100, fetchImpl,
      output: (event) => {
        if (event.type === 'authorization-url') {
          queueMicrotask(async () => {
            const authorize = new URL(event.value); const callbackUrl = new URL(authorize.searchParams.get('redirect_uri'));
            callbackUrl.search = new URLSearchParams({ state: authorize.searchParams.get('state'), code: 'synthetic_code_marker' }).toString();
            const firstCallback = fetch(callbackUrl);
            await new Promise((resolve) => setTimeout(resolve, 5));
            secondCallback = await fetch(callbackUrl);
            releaseToken();
            await firstCallback;
          });
        }
      } });
    try {
      const result = await pending;
      assert.equal(result.passed, true);
      assert.equal(tokenCalls, 1);
      assert.equal(secondCallback.status, 400);
    } finally { releaseToken(); await api.close(); }
  });

  it('rejects non-loopback API destinations', async () => {
    await assert.rejects(runSmoke({ config, scenarioName: 'missing-bearer', apiOrigin: 'https://external.example' }), /approved loopback/);
  });
});

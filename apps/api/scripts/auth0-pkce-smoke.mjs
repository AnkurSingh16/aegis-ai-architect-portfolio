#!/usr/bin/env node
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { stdin, stdout } from 'node:process';
import { createInterface } from 'node:readline/promises';
import { parseEnv } from 'node:util';
import { pathToFileURL } from 'node:url';

export const callbackHost = '127.0.0.1';
export const callbackPort = 49321;
export const callbackPath = '/auth/callback';
export const callbackTimeoutMs = 180_000;
export const requestTimeoutMs = 10_000;
export const defaultApiOrigin = 'http://127.0.0.1:4000';

const tenants = Object.freeze({
  north: '10000000-0000-4000-8000-000000000001',
  south: '20000000-0000-4000-8000-000000000002',
});

export const scenarios = Object.freeze({
  'authorized-north': { tenant: 'north', scope: 'openid read:cases', expectedStatus: 200, login: true },
  'no-membership': { tenant: 'north', scope: 'openid read:cases', expectedStatus: 403, login: true },
  'insufficient-scope': { tenant: 'north', scope: 'openid', expectedStatus: 403, login: true },
  'cross-tenant': { tenant: 'south', scope: 'openid read:cases', expectedStatus: 403, login: true },
  'missing-bearer': { tenant: 'north', scope: undefined, expectedStatus: 401, login: false },
});

export class SmokeError extends Error {
  constructor(message) { super(message); this.name = 'SmokeError'; }
}

/** Load only public Auth0/API settings from the runtime file. Never read .env.auth0. */
export async function loadSmokeConfig(filePath = '.env.api') {
  let env;
  try {
    const contents = await readFile(filePath, 'utf8');
    const publicNames = new Set(['AUTH0_ISSUER', 'AUTH0_AUDIENCE', 'AUTH0_SPA_CLIENT_ID']);
    const selectedLines = contents.split(/\r?\n/).filter((line) => {
      const name = /^\s*([A-Z][A-Z0-9_]*)\s*=/.exec(line)?.[1];
      return name !== undefined && publicNames.has(name);
    });
    const selectedNames = selectedLines.map((line) => /^\s*([A-Z][A-Z0-9_]*)\s*=/.exec(line)?.[1]);
    if (new Set(selectedNames).size !== selectedNames.length) throw new SmokeError('Duplicate local Auth0 configuration setting.');
    env = parseEnv(selectedLines.join('\n'));
  } catch (error) {
    if (error instanceof SmokeError) throw error;
    throw new SmokeError('Could not read local Auth0 configuration.');
  }
  return validateSmokeConfig(env);
}

export function validateSmokeConfig(env) {
  const issuer = env.AUTH0_ISSUER;
  const audience = env.AUTH0_AUDIENCE;
  const clientId = env.AUTH0_SPA_CLIENT_ID;
  return validatePublicConfig({ issuer, audience, clientId });
}

function validatePublicConfig(config) {
  let issuerUrl;
  try { issuerUrl = new URL(config?.issuer); } catch { throw new SmokeError('Invalid local Auth0 configuration.'); }
  if (issuerUrl.protocol !== 'https:' || issuerUrl.username || issuerUrl.password || issuerUrl.port
    || issuerUrl.pathname !== '/' || issuerUrl.search || issuerUrl.hash
    || config.issuer !== `${issuerUrl.origin}/` || issuerUrl.hostname.endsWith('.localhost')
    || issuerUrl.hostname === 'localhost' || /^[\d.]+$/.test(issuerUrl.hostname)
    || typeof config.audience !== 'string' || !config.audience || config.audience.length > 255
    || config.audience.trim() !== config.audience || /\s/.test(config.audience)
    || !/^[A-Za-z0-9_-]{1,128}$/.test(config.clientId ?? '')) {
    throw new SmokeError('Local Auth0 issuer, API audience or SPA client ID is invalid.');
  }
  return Object.freeze({ issuer: config.issuer, audience: config.audience, clientId: config.clientId });
}

export function validateScenario(name) {
  if (!Object.hasOwn(scenarios, name)) throw new SmokeError('Choose a supported smoke-test scenario.');
  return scenarios[name];
}

export function safeEqual(left, right) {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function timeoutSignal(parentSignal, milliseconds) {
  const controller = new AbortController();
  const abortFromParent = () => controller.abort();
  if (parentSignal?.aborted) controller.abort();
  else parentSignal?.addEventListener('abort', abortFromParent, { once: true });
  const timer = setTimeout(() => controller.abort(), milliseconds);
  return {
    signal: controller.signal,
    cleanup() {
      clearTimeout(timer);
      parentSignal?.removeEventListener('abort', abortFromParent);
    },
  };
}

async function boundedFetch(fetchImpl, url, init, parentSignal, timeoutMs) {
  const timeout = timeoutSignal(parentSignal, timeoutMs);
  try {
    return await fetchImpl(url, { ...init, signal: timeout.signal, redirect: 'error' });
  } catch {
    if (parentSignal?.aborted) throw new SmokeError('Smoke test cancelled.');
    throw new SmokeError('A bounded authentication or local API request failed.');
  } finally { timeout.cleanup(); }
}

function apiUrl(origin, tenantId) {
  let target;
  try { target = new URL(origin); } catch { throw new SmokeError('Invalid local API origin.'); }
  if (target.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname)
    || target.username || target.password || target.pathname !== '/' || target.search || target.hash) {
    throw new SmokeError('The API must use the approved loopback service.');
  }
  return new URL(`/api/tenants/${encodeURIComponent(tenantId)}/cases`, target);
}

/**
 * Run one local smoke scenario. Injectable options are for deterministic tests;
 * the CLI uses the fixed callback port, local API origin and global fetch.
 */
export async function runSmoke({ config, scenarioName, fetchImpl = globalThis.fetch,
  apiOrigin = defaultApiOrigin, listenPort = callbackPort, callbackTimeout = callbackTimeoutMs,
  requestTimeout = requestTimeoutMs, signal, output = () => {} }) {
  const scenario = validateScenario(scenarioName);
  config = validatePublicConfig(config);
  if (typeof fetchImpl !== 'function') throw new SmokeError('HTTP client is unavailable.');
  const targetUrl = apiUrl(apiOrigin, tenants[scenario.tenant]);
  if (!scenario.login) {
    const response = await boundedFetch(fetchImpl, targetUrl, { method: 'GET', headers: { accept: 'application/json' } }, signal, requestTimeout);
    return reportStatus(output, scenarioName, response.status, scenario.expectedStatus);
  }

  let verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const state = randomBytes(32).toString('base64url');
  const server = createServer();
  const sockets = new Set();
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  const abortController = new AbortController();
  const abortFromParent = () => abortController.abort();
  if (signal?.aborted) abortController.abort();
  else signal?.addEventListener('abort', abortFromParent, { once: true });
  let claimed = false;
  let accessToken;
  let callbackTimer;
  let rejectOnCancel;
  let resolveCallback;
  let rejectCallback;
  let callbackSettled = false;
  const callbackResult = new Promise((resolve, reject) => {
    resolveCallback = resolve;
    rejectCallback = reject;
  });
  let listenerClosed;
  const closed = new Promise((resolve) => { listenerClosed = resolve; });
  let didClose = false;
  const settleClosed = () => { if (!didClose) { didClose = true; listenerClosed(); } };
  server.once('close', settleClosed);
  const onAbort = () => {
    server.close();
    server.closeAllConnections?.();
    for (const socket of sockets) socket.destroy();
  };
  abortController.signal.addEventListener('abort', onAbort, { once: true });

  const fail = (message) => {
    if (!callbackSettled) {
      callbackSettled = true;
      rejectCallback(new SmokeError(message));
    }
    server.close();
  };

  server.on('request', (request, response) => {
    let callbackUrl;
    try { callbackUrl = new URL(request.url ?? '/', `http://${callbackHost}`); }
    catch {
      response.writeHead(400, { 'content-type': 'text/plain' }).end('Invalid callback.');
      fail('Invalid login callback.');
      return;
    }
    if (claimed) {
      response.writeHead(400, { 'content-type': 'text/plain' }).end('Login callback already processed.');
      return;
    }
    if (request.method !== 'GET' || callbackUrl.pathname !== callbackPath
      || request.headers.host !== `${callbackHost}:${actualPort}`) {
      response.writeHead(404, { 'content-type': 'text/plain' }).end('Invalid callback.');
      fail('Invalid login callback.');
      return;
    }
    const states = callbackUrl.searchParams.getAll('state');
    const codes = callbackUrl.searchParams.getAll('code');
    const errors = callbackUrl.searchParams.getAll('error');
    const returnedIssuers = callbackUrl.searchParams.getAll('iss');
    const supportedParameters = new Set(['state', 'code', 'error', 'error_description', 'error_uri', 'iss']);
    const hasUnexpectedParameter = [...callbackUrl.searchParams.keys()].some((key) => !supportedParameters.has(key));
    if (states.length !== 1 || !safeEqual(states[0] ?? '', state)
      || hasUnexpectedParameter || returnedIssuers.length > 1
      || (returnedIssuers.length === 1 && returnedIssuers[0] !== config.issuer)) {
      claimed = true;
      response.writeHead(400, { 'content-type': 'text/plain' }).end('Authentication was not completed. You may close this window.');
      fail('Authentication callback validation failed.');
      return;
    }
    if (errors.length > 0) {
      claimed = true;
      response.writeHead(400, { 'content-type': 'text/plain' }).end('Authentication was not completed. You may close this window.');
      fail('Auth0 authorization was not completed.');
      return;
    }
    if (codes.length !== 1 || !codes[0] || codes[0].length > 4096) {
      claimed = true;
      response.writeHead(400, { 'content-type': 'text/plain' }).end('Authentication was not completed. You may close this window.');
      fail('Authentication callback validation failed.');
      return;
    }
    claimed = true;
    void (async () => {
      try {
        const tokenUrl = new URL('oauth/token', config.issuer);
        const tokenResponse = await boundedFetch(fetchImpl, tokenUrl, {
          method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify({ grant_type: 'authorization_code', client_id: config.clientId,
            code: codes[0], redirect_uri: callbackUrlFor(actualPort), code_verifier: verifier }),
        }, abortController.signal, requestTimeout);
        let tokenPayload;
        try { tokenPayload = await tokenResponse.json(); } catch { throw new SmokeError('Auth0 token exchange failed.'); }
        if (!tokenResponse.ok || typeof tokenPayload?.access_token !== 'string'
          || tokenPayload.access_token.length < 8 || tokenPayload.access_token.length > 8192
          || typeof tokenPayload.token_type !== 'string' || tokenPayload.token_type.toLowerCase() !== 'bearer') {
          throw new SmokeError('Auth0 token exchange failed.');
        }
        accessToken = tokenPayload.access_token;
        tokenPayload = undefined;
        response.writeHead(200, { 'content-type': 'text/plain' }).end('Sign-in completed. You may close this window.');
        if (!callbackSettled) { callbackSettled = true; resolveCallback(); }
      } catch {
        response.writeHead(400, { 'content-type': 'text/plain' }).end('Sign-in failed. You may close this window.');
        fail('Auth0 token exchange failed.');
      } finally { server.close(); }
    })();
  });

  let actualPort = listenPort;
  try {
    await new Promise((resolve, reject) => {
      const onError = () => { settleClosed(); reject(new SmokeError('Could not start the local callback listener.')); };
      server.once('error', onError);
      server.listen(listenPort, callbackHost, () => {
        server.off('error', onError);
        const address = server.address();
        if (!address || typeof address === 'string') reject(new SmokeError('Could not start the local callback listener.'));
        else { actualPort = address.port; resolve(); }
      });
    });
    if (abortController.signal.aborted) throw new SmokeError('Smoke test cancelled.');
    const redirectUri = callbackUrlFor(actualPort);
    const authorize = new URL('authorize', config.issuer);
    authorize.search = new URLSearchParams({ response_type: 'code', client_id: config.clientId,
      redirect_uri: redirectUri, audience: config.audience, scope: scenario.scope,
      code_challenge: challenge, code_challenge_method: 'S256', state }).toString();
    callbackTimer = setTimeout(() => fail('Login callback timed out.'), callbackTimeout);
    rejectOnCancel = () => fail('Smoke test cancelled.');
    abortController.signal.addEventListener('abort', rejectOnCancel, { once: true });
    output({ type: 'authorization-url', value: authorize.toString() });
    output({ type: 'message', value: 'Complete sign-in in the browser. The access token will remain in memory only.' });
    await callbackResult;
    abortController.signal.removeEventListener('abort', rejectOnCancel);
    if (abortController.signal.aborted) throw new SmokeError('Smoke test cancelled.');
    if (!accessToken) throw new SmokeError('Auth0 token exchange failed.');
    const response = await boundedFetch(fetchImpl, targetUrl, {
      method: 'GET', headers: { accept: 'application/json', authorization: `Bearer ${accessToken}` },
    }, abortController.signal, requestTimeout);
    return reportStatus(output, scenarioName, response.status, scenario.expectedStatus);
  } finally {
    clearTimeout(callbackTimer);
    if (rejectOnCancel) abortController.signal.removeEventListener('abort', rejectOnCancel);
    abortController.abort();
    signal?.removeEventListener('abort', abortFromParent);
    server.close();
    server.closeAllConnections?.();
    for (const socket of sockets) socket.destroy();
    if (!server.listening) settleClosed();
    await closed;
    accessToken = undefined;
    verifier = undefined;
    abortController.signal.removeEventListener('abort', onAbort);
  }
}

function callbackUrlFor(port) { return `http://${callbackHost}:${port}${callbackPath}`; }

function reportStatus(output, scenarioName, actualStatus, expectedStatus) {
  if (actualStatus !== expectedStatus) {
    output({ type: 'error', value: `${scenarioName} returned HTTP ${actualStatus}; expected HTTP ${expectedStatus}.` });
    return { scenario: scenarioName, expectedStatus, actualStatus, passed: false };
  }
  output({ type: 'result', value: `${scenarioName} returned the expected HTTP ${expectedStatus}.` });
  return { scenario: scenarioName, expectedStatus, actualStatus, passed: true };
}

async function main() {
  if (!stdin.isTTY || !stdout.isTTY) {
    console.error('Interactive terminal required. Run this command in a normal VS Code Terminal.');
    process.exitCode = 2;
    return;
  }
  const controller = new AbortController();
  const onSigint = () => controller.abort();
  process.once('SIGINT', onSigint);
  const readline = createInterface({ input: stdin, output: stdout });
  try {
    const config = await loadSmokeConfig();
    console.info('Choose one local smoke-test scenario:');
    for (const [name, scenario] of Object.entries(scenarios)) {
      console.info(`  ${name}: expected HTTP ${scenario.expectedStatus}${scenario.login ? ', browser sign-in required' : ', no sign-in'}`);
    }
    const name = (await readline.question('Scenario: ')).trim();
    validateScenario(name);
    const result = await runSmoke({ config, scenarioName: name, signal: controller.signal,
      output: (event) => {
        if (event.type === 'authorization-url') console.info(`Open this authorization URL: ${event.value}`);
        else if (event.type === 'error') console.error(event.value);
        else console.info(event.value);
      } });
    if (!result.passed) process.exitCode = 1;
  } catch (error) {
    const message = error instanceof SmokeError ? error.message : 'Smoke test failed safely.';
    console.error(message);
    process.exitCode = 1;
  } finally {
    readline.close();
    process.off('SIGINT', onSigint);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();

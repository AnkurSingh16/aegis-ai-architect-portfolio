#!/usr/bin/env node
import { stdin, stdout } from 'node:process';
import { pathToFileURL } from 'node:url';
import { createLocalConfigurationLoader, isAutomatedContext } from './apply-browser-origin-update.mjs';

const requestTimeoutMs = 10_000;

function record(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }

export function assertInspectionInvocation({ argv = process.argv, stdinIsTTY = stdin.isTTY, stdoutIsTTY = stdout.isTTY,
  env = process.env } = {}) {
  if (argv.length !== 2 || !stdinIsTTY || !stdoutIsTTY || isAutomatedContext(env)) {
    throw new Error('This read-only Auth0 inspection requires a normal interactive terminal and accepts no arguments.');
  }
}

export function classifySpaJwtAlgorithm(client) {
  if (!record(client)) return 'unexpected';
  if (!Object.hasOwn(client, 'jwt_configuration')) return 'missing';
  if (!record(client.jwt_configuration)) return 'unexpected';
  if (!Object.hasOwn(client.jwt_configuration, 'alg')) return 'missing';
  const algorithm = client.jwt_configuration.alg;
  if (algorithm === '') return 'empty';
  if (algorithm === 'HS256' || algorithm === 'RS256') return algorithm;
  return 'unexpected';
}

async function request(fetchImpl, url, options, signal) {
  const controller = new AbortController();
  let rejectAborted;
  const aborted = new Promise((_, reject) => { rejectAborted = reject; });
  void aborted.catch(() => {});
  const abort = () => {
    controller.abort();
    rejectAborted(new Error('Read-only Auth0 request failed or timed out.'));
  };
  const timer = setTimeout(abort, requestTimeoutMs);
  timer.unref?.();
  if (signal?.aborted) abort();
  else signal?.addEventListener('abort', abort, { once: true });
  try {
    const response = await fetchImpl(url, { ...options, signal: controller.signal, redirect: 'error' });
    if (!response.ok) return { response, body: null };
    const body = await Promise.race([response.json(), aborted]);
    return { response, body };
  } catch {
    throw new Error('Read-only Auth0 request failed or timed out.');
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
  }
}

export async function inspectSpaJwtAlgorithm({ loadConfiguration, fetchImpl = fetch, signal,
  isInteractive = () => Boolean(stdin.isTTY && stdout.isTTY) } = {}) {
  if (!isInteractive()) throw new Error('Run this read-only inspection from a normal interactive terminal.');
  if (typeof loadConfiguration !== 'function' || typeof fetchImpl !== 'function') {
    throw new Error('Read-only Auth0 inspection is not configured.');
  }

  let configuration;
  try { configuration = await loadConfiguration(); }
  catch { throw new Error('Protected local Auth0 development configuration is unavailable.'); }
  const domain = configuration?.auth0Domain;
  const spaClientId = configuration?.spaClientId;
  const clientId = configuration?.auth0ClientId;
  const clientSecret = configuration?.auth0ClientSecret;
  if (typeof domain !== 'string' || !/^[A-Za-z0-9.-]+\.auth0\.com$/.test(domain) ||
      typeof spaClientId !== 'string' || !spaClientId || typeof clientId !== 'string' || !clientId ||
      typeof clientSecret !== 'string' || !clientSecret) {
    throw new Error('Protected local Auth0 development configuration is invalid.');
  }

  const origin = `https://${domain}`;
  const { response: tokenResponse, body: tokenDocument } = await request(fetchImpl, `${origin}/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret,
      audience: `${origin}/api/v2/`, scope: 'read:clients' }),
  }, signal);
  if (!tokenResponse.ok) return Object.freeze({ status: 'read-permission-unavailable', classification: null });
  if (!record(tokenDocument) || typeof tokenDocument.access_token !== 'string' || tokenDocument.access_token.length === 0) {
    return Object.freeze({ status: 'management-token-unavailable', classification: null });
  }

  const { response: clientResponse, body: clientDocument } = await request(fetchImpl, `${origin}/api/v2/clients/${encodeURIComponent(spaClientId)}`, {
    method: 'GET', headers: { authorization: `Bearer ${tokenDocument.access_token}` },
  }, signal);
  if (clientResponse.status === 403) return Object.freeze({ status: 'read-permission-unavailable', classification: null });
  if (clientResponse.status === 404) return Object.freeze({ status: 'spa-not-found', classification: null });
  if (!clientResponse.ok) return Object.freeze({ status: 'client-read-unavailable', classification: null });
  if (!record(clientDocument) || clientDocument.client_id !== spaClientId) {
    return Object.freeze({ status: 'spa-identity-unverified', classification: null });
  }
  return Object.freeze({ status: 'verified', classification: classifySpaJwtAlgorithm(clientDocument) });
}

async function main() {
  assertInspectionInvocation();
  const controller = new AbortController();
  const onInterrupt = () => controller.abort();
  process.once('SIGINT', onInterrupt);
  process.once('SIGTERM', onInterrupt);
  try {
    const result = await inspectSpaJwtAlgorithm({
      loadConfiguration: createLocalConfigurationLoader(),
      signal: controller.signal,
    });
    if (result.status === 'verified') stdout.write(`Auth0 SPA jwt_configuration.alg: ${result.classification}\n`);
    else stdout.write(`Auth0 SPA JWT read-only check: ${result.status}\n`);
    if (result.status !== 'verified') process.exitCode = 1;
  } catch (error) {
    stdout.write(`${error instanceof Error ? error.message : 'Read-only Auth0 inspection failed.'}\n`);
    process.exitCode = 1;
  } finally {
    process.off('SIGINT', onInterrupt);
    process.off('SIGTERM', onInterrupt);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();

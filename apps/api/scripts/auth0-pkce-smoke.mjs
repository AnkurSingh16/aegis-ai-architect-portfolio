#!/usr/bin/env node
import { createServer } from 'node:http';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';

if (!stdin.isTTY || !stdout.isTTY) {
  console.error('Interactive terminal required. Run node apps/api/scripts/auth0-pkce-smoke.mjs in VS Code Terminal.');
  process.exit(2);
}

const readline = createInterface({ input: stdin, output: stdout });
const ask = (label) => readline.question(label);
const domain = (await ask('Auth0 domain: ')).trim();
const clientId = (await ask('SPA client ID: ')).trim();
const audience = (await ask('Case API audience: ')).trim();
const tenantId = (await ask('Authorized test tenant UUID: ')).trim();
const apiOrigin = (await ask('Local API origin [http://127.0.0.1:4000]: ')).trim() || 'http://127.0.0.1:4000';
readline.close();

if (!/^[A-Za-z0-9.-]+$/.test(domain) || !clientId || !audience || !/^[0-9a-f-]{36}$/i.test(tenantId)) {
  console.error('Invalid public Auth0 settings or tenant UUID.');
  process.exit(2);
}
const api = new URL(apiOrigin);
if (api.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(api.hostname)) {
  console.error('The API origin must use HTTP on localhost.');
  process.exit(2);
}

const callback = 'http://127.0.0.1:49321/auth/callback';
const verifier = randomBytes(32).toString('base64url');
const challenge = createHash('sha256').update(verifier).digest('base64url');
const state = randomBytes(24).toString('base64url');
let accessToken;
let tokenExchangeError = false;
const server = createServer(async (request, response) => {
  const received = new URL(request.url, callback);
  if (received.pathname !== '/auth/callback') {
    response.writeHead(404).end();
    return;
  }
  const returnedState = received.searchParams.get('state') ?? '';
  if (received.searchParams.has('error') || !safeEqual(returnedState, state) || !received.searchParams.get('code')) {
    response.writeHead(400, { 'content-type': 'text/plain' }).end('Authentication was not completed. You may close this window.');
    tokenExchangeError = true;
    server.close();
    return;
  }
  try {
    const responseFromAuth0 = await fetch(`https://${domain}/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ grant_type: 'authorization_code', client_id: clientId,
        code: received.searchParams.get('code'), redirect_uri: callback, code_verifier: verifier }),
    });
    const tokenResponse = await responseFromAuth0.json();
    if (!responseFromAuth0.ok || typeof tokenResponse.access_token !== 'string'
      || tokenResponse.token_type?.toLowerCase() !== 'bearer') throw new Error('token exchange failed');
    accessToken = tokenResponse.access_token;
    response.writeHead(200, { 'content-type': 'text/plain' }).end('Sign-in completed. You may close this window.');
  } catch {
    tokenExchangeError = true;
    response.writeHead(400, { 'content-type': 'text/plain' }).end('Sign-in failed. You may close this window.');
  } finally {
    server.close();
  }
});

await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(49321, '127.0.0.1', resolve);
});
const authorize = new URL(`https://${domain}/authorize`);
authorize.search = new URLSearchParams({ response_type: 'code', client_id: clientId,
  redirect_uri: callback, audience, scope: 'openid profile email read:cases',
  code_challenge: challenge, code_challenge_method: 'S256', state }).toString();
console.info('Open this authorization URL in your browser to sign in:');
console.info(authorize.toString());
console.info('The access token is held in memory only and will not be displayed or saved.');

await new Promise((resolve) => server.once('close', resolve));
if (tokenExchangeError || !accessToken) {
  console.error('Auth0 authorization or token exchange failed; no token details were printed.');
  process.exitCode = 1;
} else {
  try {
    const casesUrl = new URL(`/api/tenants/${encodeURIComponent(tenantId)}/cases`, apiOrigin);
    const result = await fetch(casesUrl, { headers: { authorization: `Bearer ${accessToken}` } });
    console.info(`Authenticated case-list request returned HTTP ${result.status}.`);
    if (!result.ok) process.exitCode = 1;
  } catch {
    console.error('Local API request failed. Token contents were not printed.');
    process.exitCode = 1;
  } finally {
    accessToken = undefined;
  }
}

function safeEqual(left, right) {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

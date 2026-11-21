import { expect, test } from '@playwright/test';
import { TENANT_NORTH, WEB, compose, seedSyntheticCases, signIn, tokenExpiry, waitForApiReady, waitForRealm } from './support';

test.beforeAll(() => { seedSyntheticCases(); });

test('anonymous visitor sees sign-in and no protected case data', async ({ page }) => {
  const protectedCalls: string[] = [];
  page.on('request', (request) => { if (request.url().includes('/api/tenants/')) protectedCalls.push(request.url()); });
  await page.goto(`${WEB}/`);
  await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible();
  await expect(page.getByText('SYNTHETIC-LOGIN-001')).toHaveCount(0);
  expect(protectedCalls).toHaveLength(0);
});

test('interactive Keycloak sign-in returns to the app, cleans the address bar and reads a protected case', async ({ page }) => {
  const authorised: string[] = [];
  page.on('request', (request) => {
    if (request.url().includes(`/api/tenants/${TENANT_NORTH}/cases`) && request.headers().authorization) authorised.push(request.url());
  });
  await signIn(page, 'alice.north');
  await expect(page.getByText('SYNTHETIC-LOGIN-001')).toBeVisible({ timeout: 30_000 });
  expect(page.url()).not.toMatch(/[?&](code|state|session_state)=/);
  expect(authorised.length).toBeGreaterThan(0);
});

test('logs contain no access token material', async () => {
  const logs = ['api', 'web'].map((service) => compose(['logs', '--no-color', service]));
  for (const text of logs) expect(text).not.toMatch(/eyJ[A-Za-z0-9_-]{10,}\./);
});

test('tenant isolation: a North member is refused the South tenant in the browser', async ({ page }) => {
  const statuses: number[] = [];
  page.on('response', (response) => { if (response.url().includes('/api/tenants/')) statuses.push(response.status()); });
  await signIn(page, 'alice.north');
  await expect(page.getByText('SYNTHETIC-LOGIN-001')).toBeVisible({ timeout: 30_000 });
  await page.locator('#case-tenant').selectOption({ label: 'Synthetic South' });
  await expect.poll(() => statuses.includes(403), { timeout: 30_000 }).toBeTruthy();
  await expect(page.getByText('SYNTHETIC-BILLING-002')).toHaveCount(0);
});

test('reader cannot submit a human review; operator can', async ({ browser }) => {
  const readerContext = await browser.newContext();
  const reader = await readerContext.newPage();
  await signIn(reader, 'alice.north');
  await expect(reader.getByText('SYNTHETIC-LOGIN-001')).toBeVisible({ timeout: 30_000 });
  await expect(reader.getByRole('button', { name: 'Approve', exact: true })).toHaveCount(0);
  await readerContext.close();

  const operatorContext = await browser.newContext();
  const operator = await operatorContext.newPage();
  await signIn(operator, 'olivia.north');
  await expect(operator.getByText('SYNTHETIC-LOGIN-001')).toBeVisible({ timeout: 30_000 });
  await operator.getByRole('button', { name: 'Approve', exact: true }).first().click();
  await operator.getByRole('button', { name: 'Confirm review' }).first().click();
  await expect(operator.getByRole('status').filter({ hasText: 'Human review saved.' })).toBeVisible({ timeout: 30_000 });
  await operatorContext.close();
});

test('invalid callback state is refused and the code is removed from the address bar', async ({ page }) => {
  await page.goto(`${WEB}/?code=forged-authorisation-code&state=forged-state`);
  await expect(page.getByRole('alert').filter({ hasText: 'Sign-in could not be completed' })).toBeVisible({ timeout: 30_000 });
  expect(page.url()).not.toMatch(/[?&](code|state)=/);
  await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible();
});

test('sign-out ends the local session and the Keycloak session, so protected data is gone', async ({ page }) => {
  await signIn(page, 'alice.north');
  await expect(page.getByText('SYNTHETIC-LOGIN-001')).toBeVisible({ timeout: 30_000 });
  await page.getByRole('button', { name: 'Sign out' }).click();
  await page.waitForURL(/localhost:8180\/realms\/aegis/, { timeout: 30_000 }).catch(() => undefined);
  await page.goto(`${WEB}/`);
  await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText('SYNTHETIC-LOGIN-001')).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible({ timeout: 30_000 });
});

test('an unavailable identity provider is reported, and sign-in works again after it recovers', async ({ page }) => {
  compose(['stop', 'keycloak']);
  try {
    await page.goto(`${WEB}/`);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(page.getByRole('alert').filter({ hasText: 'The identity provider is unavailable' })).toBeVisible({ timeout: 60_000 });
  } finally {
    compose(['start', 'keycloak']);
    await waitForRealm();
  }
  await signIn(page, 'alice.north');
  await expect(page.getByText('SYNTHETIC-LOGIN-001')).toBeVisible({ timeout: 60_000 });
});

test('an access token nearing its 60-second lifetime is renewed without re-entering credentials', async ({ page }) => {
  const tokens: string[] = [];
  page.on('request', (request) => {
    const auth = request.headers().authorization;
    if (auth && request.url().includes('/api/tenants/')) tokens.push(auth);
  });
  await signIn(page, 'alice.north');
  await expect(page.getByText('SYNTHETIC-LOGIN-001')).toBeVisible({ timeout: 30_000 });
  const first = tokens.at(-1);
  if (!first) throw new Error('no token was sent');
  const firstExpiry = tokenExpiry(first);
  // Wait beyond the first token's expiry window, then make another protected call. The session must supply a fresh token.
  await page.waitForTimeout(Math.max(0, (firstExpiry - Date.now() / 1000 + 15) * 1000));
  await page.locator('#case-tenant').selectOption({ label: 'Synthetic South' });
  await page.locator('#case-tenant').selectOption({ label: 'Synthetic North' });
  await expect(page.getByText('SYNTHETIC-LOGIN-001')).toBeVisible({ timeout: 30_000 });
  const latest = tokens.at(-1);
  if (!latest || latest === first) throw new Error('the session did not renew the token');
  expect(tokenExpiry(latest)).toBeGreaterThan(firstExpiry);
});

test('restarting the API keeps the identity session, and the application restores it without a password prompt', async ({ page }) => {
  await signIn(page, 'alice.north');
  await expect(page.getByText('SYNTHETIC-LOGIN-001')).toBeVisible({ timeout: 30_000 });
  compose(['restart', 'api']);
  await waitForApiReady();
  await page.reload();
  await expect(page.getByText('SYNTHETIC-LOGIN-001')).toBeVisible({ timeout: 60_000 });
});

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { Page } from '@playwright/test';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** Values from the local .env.local. They are used only to drive the browser test. They are never logged. */
export const env: Record<string, string> = Object.fromEntries(readFileSync(join(root, '.env.local'), 'utf8').split('\n')
  .map((line) => /^([A-Z0-9_]+)=(.*)$/.exec(line.trim())).filter((m): m is RegExpExecArray => m !== null).map((m) => [m[1], m[2]]));

export const TENANT_NORTH = '10000000-0000-4000-8000-000000000001';
export const TENANT_SOUTH = '20000000-0000-4000-8000-000000000002';
export const WEB = process.env.AEGIS_WEB_BASE_URL ?? 'http://localhost:5190';
export const PASSWORD = env.AEGIS_KC_TEST_USER_PASSWORD;

/** Runs a compose command for the local project only. Never touches other projects or volumes. */
export function compose(args: string[]): string {
  return execFileSync('docker', ['compose', '-p', 'aegis-local', '--env-file', join(root, '.env.local'), ...args],
    { cwd: root, encoding: 'utf8' });
}

/** Seeds one synthetic case per tenant when none exists. Nothing is deleted. */
export function seedSyntheticCases(): void {
  const seed = (tenant: string, syntheticId: string) => `
SELECT set_config('aegis.tenant_id', '${tenant}', false);
INSERT INTO aegis.support_cases (tenant_id, synthetic_case_id)
SELECT '${tenant}', '${syntheticId}'
WHERE NOT EXISTS (SELECT 1 FROM aegis.support_cases WHERE tenant_id = '${tenant}');`;
  const sql = seed(TENANT_NORTH, 'SYNTHETIC-LOGIN-001') + seed(TENANT_SOUTH, 'SYNTHETIC-BILLING-002');
  execFileSync('docker', ['compose', '-p', 'aegis-local', '--env-file', join(root, '.env.local'), 'exec', '-T', 'postgres',
    'psql', '-U', 'aegis_admin', '-d', 'aegis_local', '-v', 'ON_ERROR_STOP=1', '-q', '-f', '-'], { cwd: root, input: sql, encoding: 'utf8' });
}

/** Waits until the container reports healthy. A started container is not yet a ready identity provider. */
export async function waitForContainerHealthy(container: string, timeoutMs = 180_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = execFileSync('docker', ['inspect', '-f', '{{.State.Health.Status}}', container], { encoding: 'utf8' }).trim();
    if (status === 'healthy') return;
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  throw new Error(`${container} did not become healthy in time`);
}

/** Signs in through the real Keycloak login page, as an interactive user would. If Keycloak reports a stale attempt, the flow is
 *  restarted once from the application, exactly as a user would do. */
export async function signIn(page: Page, username: string): Promise<void> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await page.goto(`${WEB}/`);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await page.waitForURL(/localhost:8180\/realms\/aegis/);
    await page.locator('#username').fill(username);
    await page.locator('#password').fill(PASSWORD);
    await page.locator('#kc-login').click();
    const stale = await page.getByText('Your login attempt timed out').waitFor({ timeout: 5000 }).then(() => true, () => false);
    if (!stale) break;
  }
  await page.waitForURL((url) => url.origin === WEB);
}

/** The subject-independent expiry (`exp`, seconds) of a JWT, read for test assertions only. */
export function tokenExpiry(jwt: string): number {
  const payload = jwt.replace(/^Bearer /, '').split('.')[1];
  return (JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { exp: number }).exp;
}

/** Waits until the identity provider serves the application realm again. */
export async function waitForRealm(timeoutMs = 120_000): Promise<void> {
  const url = `http://localhost:${env.AEGIS_PORT_KEYCLOAK ?? 8180}/realms/aegis/.well-known/openid-configuration`;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(url, { signal: AbortSignal.timeout(3000) })).ok) return;
    } catch { /* not yet */ }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  throw new Error('identity provider did not recover in time');
}

/** Waits until the API reports ready (database and migrations). */
export async function waitForApiReady(timeoutMs = 120_000): Promise<void> {
  const url = `http://localhost:${env.AEGIS_PORT_API ?? 4110}/api/ready`;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(url, { signal: AbortSignal.timeout(3000) })).status === 200) return;
    } catch { /* not yet */ }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  throw new Error('API did not become ready in time');
}

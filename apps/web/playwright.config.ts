import { defineConfig, devices } from '@playwright/test';

// Browser acceptance tests against the locally deployed production build, Keycloak and the API (docker compose project aegis-local).
// They run only when AEGIS_STACK_E2E=1, so ordinary test runs and CI jobs without the stack are unaffected. No cloud credentials are used.
const enabled = process.env.AEGIS_STACK_E2E === '1';

export default defineConfig({
  testDir: './e2e-stack',
  // Without AEGIS_STACK_E2E=1 the suite is skipped entirely, so ordinary CI runs (which have no stack) are unaffected.
  testIgnore: enabled ? [] : ['**/*.spec.ts'],
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 120_000,
  reporter: 'list',
  use: {
    baseURL: process.env.AEGIS_WEB_BASE_URL ?? 'http://localhost:5190',
    ...devices['Desktop Chrome'],
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
});

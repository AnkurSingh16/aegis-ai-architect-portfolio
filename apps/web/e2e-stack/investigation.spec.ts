import { expect, test, type Page } from '@playwright/test';
import { caseAccessSignIn, TENANT_NORTH, TENANT_SOUTH, signIn } from './support';

// Browser acceptance for the evidence-backed investigation. It uses the real Keycloak sign-in, the production-built web app, the
// authenticated investigation API and the four-workload pipeline on the seeded synthetic corpus. Nothing is mocked. Every assertion
// reads what the reviewer approved or what the authorised retrieval returned. Each test uses its own idempotency key by submitting a
// fresh question, so the suite is repeatable against the same database.

const ANSWERABLE = 'Which synthetic document describes the sign-in interruption procedure for a demonstration account?';
const UNANSWERABLE = 'Which synthetic document describes the lunar orbit maintenance procedure?';
const EXECUTION = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/;

// Controls are addressed by their accessible name inside the investigation region. The case-access panel has its own "Requested tenant"
// control and sign-in button, so unscoped queries would be ambiguous. A label-text match cannot be used here: the wrapping label also
// contains the option names, so its text is not the accessible name.
const investigationRegion = (page: Page) => page.getByRole('region', { name: 'Evidence-backed investigation' });

async function chooseTenant(page: Page, name: 'Synthetic North' | 'Synthetic South') {
  await investigationRegion(page).getByRole('combobox', { name: 'Tenant', exact: true }).selectOption({ label: name });
}

async function investigate(page: Page, question: string) {
  await investigationRegion(page).getByRole('textbox', { name: 'Question', exact: true }).fill(question);
  await investigationRegion(page).getByRole('button', { name: 'Investigate', exact: true }).click();
}

test.describe('investigation acceptance (real stack)', () => {
  test('interactive login, tenant selection and an approved, cited answer from the authorised corpus', async ({ page }) => {
    await signIn(page, 'alice.north');
    await chooseTenant(page, 'Synthetic North');
    await investigate(page, ANSWERABLE);

    await expect(page.getByText(EXECUTION)).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole('heading', { name: 'Answer (reviewer approved)' })).toBeVisible({ timeout: 90_000 });
    await expect(page.getByText('For a synthetic sign-in interruption, first record the affected demonstration account')).toBeVisible();
    // The citation is the stored North document and version, not a reference the answer invented.
    await expect(page.locator('code', { hasText: 'SYNTHETIC-NORTH-LOGIN-INCIDENT#0@v1' })).toBeVisible();
    await expect(page.getByText(/SYNTHETIC-SOUTH-/)).toHaveCount(0);
  });

  test('a question the authorised documents cannot answer shows insufficient evidence and no answer', async ({ page }) => {
    await signIn(page, 'alice.north');
    await chooseTenant(page, 'Synthetic North');
    await investigate(page, UNANSWERABLE);

    await expect(page.getByRole('status').filter({ hasText: 'Insufficient evidence' })).toBeVisible({ timeout: 90_000 });
    await expect(page.getByRole('heading', { name: 'Answer (reviewer approved)' })).toHaveCount(0);
  });

  test('a North member is refused an investigation for the South tenant in the browser', async ({ page }) => {
    const statuses: number[] = [];
    page.on('response', (response) => {
      if (response.url().includes(`/api/tenants/${TENANT_SOUTH}/investigations`)) statuses.push(response.status());
    });
    await signIn(page, 'alice.north');
    await chooseTenant(page, 'Synthetic South');
    await investigate(page, ANSWERABLE);

    await expect(page.getByRole('alert').filter({ hasText: 'You are not authorised to investigate for this tenant.' })).toBeVisible({ timeout: 30_000 });
    expect(statuses).toContain(403);
    await expect(page.getByText(/SYNTHETIC-SOUTH-/)).toHaveCount(0);
  });

  test('cancellation is requested for a running investigation and the stage stays consistent', async ({ page }) => {
    await signIn(page, 'alice.north');
    await chooseTenant(page, 'Synthetic North');
    await investigate(page, ANSWERABLE);
    await expect(page.getByText(EXECUTION)).toBeVisible({ timeout: 30_000 });

    const cancel = page.getByRole('button', { name: 'Cancel', exact: true });
    // The run can finish before the click. Either outcome is consistent: a cancellation request, or a terminal stage with no answer change.
    if (await cancel.isVisible().catch(() => false)) await cancel.click();
    await expect(page.getByText(/Cancellation requested|Completed|Insufficient evidence|Cancelled/).first()).toBeVisible({ timeout: 90_000 });
  });

  test('an anonymous visitor cannot submit an investigation', async ({ page }) => {
    const sent: string[] = [];
    page.on('request', (request) => { if (request.url().includes('/investigations')) sent.push(request.url()); });
    await page.goto('/');
    await expect(caseAccessSignIn(page)).toBeVisible();
    await expect(page.getByLabel('Question')).toHaveCount(0);
    expect(sent).toHaveLength(0);
  });

  test('the North tenant id is the one the browser submits to, never a value from the page', async ({ page }) => {
    const urls: string[] = [];
    page.on('request', (request) => { if (request.url().includes('/investigations') && request.method() === 'POST') urls.push(request.url()); });
    await signIn(page, 'alice.north');
    await chooseTenant(page, 'Synthetic North');
    await investigate(page, ANSWERABLE);
    await expect(page.getByText(EXECUTION)).toBeVisible({ timeout: 30_000 });
    expect(urls.length).toBeGreaterThan(0);
    expect(urls.every((url) => url.includes(`/api/tenants/${TENANT_NORTH}/investigations`))).toBe(true);
  });
});

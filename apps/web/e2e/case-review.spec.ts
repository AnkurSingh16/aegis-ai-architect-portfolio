import { expect, test, type Page, type Route } from '@playwright/test';

const northTenant = '10000000-0000-4000-8000-000000000001';
const southTenant = '20000000-0000-4000-8000-000000000002';
const caseId = '00000000-0000-4000-8000-000000000001';
const reviewTime = '2026-11-14T12:00:00.000Z';

type Review = { review_id: string; tenant_id: string; case_id: string; decision: 'approve' | 'reject' | 'defer';
  actor_issuer: string; actor_subject: string; note: string | null; created_at: string };

async function json(route: Route, value: unknown, status = 200, headers: Record<string, string> = {}) {
  await route.fulfill({ status, contentType: 'application/json', headers, body: JSON.stringify(value) });
}

async function installSyntheticApi(page: Page, role: 'operator' | 'reader') {
  const reviews: Review[] = role === 'reader' ? [{ review_id: 'synthetic-existing-review', tenant_id: northTenant, case_id: caseId,
    decision: 'defer', actor_issuer: 'https://synthetic-auth.example/', actor_subject: 'synthetic|previous-operator',
    note: null, created_at: reviewTime }] : [];
  const submissions: string[] = [];
  const requests: string[] = [];
  const unexpectedRequests: string[] = [];
  const caseRow = (tenantId: string) => ({ id: caseId, tenant_id: tenantId, synthetic_case_id: 'SYNTHETIC-LOGIN-001',
    status: 'in_progress', created_at: reviewTime, updated_at: reviewTime });

  await page.route('**/*', async (route) => {
    if (new URL(route.request().url()).origin !== 'http://127.0.0.1:5174') {
      unexpectedRequests.push(new URL(route.request().url()).origin);
      await route.abort('blockedbyclient');
      return;
    }
    await route.continue();
  });
  await page.route('http://127.0.0.1:5174/api/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    requests.push(`${request.method()} ${url.pathname}`);
    const segments = url.pathname.split('/').filter(Boolean);
    if (url.pathname === '/api/health') return json(route, { ok: true, service: 'aegis-api', mode: 'starter' });
    if (segments.length === 4 && segments.at(-1) === 'cases' && request.method() === 'GET') {
      const tenantId = segments[2];
      if (tenantId === southTenant || tenantId !== northTenant) return json(route, { error: 'forbidden' }, 403);
      return json(route, [caseRow(tenantId)], 200, { 'X-Aegis-Can-Review': role === 'operator' ? 'true' : 'false' });
    }
    if (segments.length === 6 && segments.at(-1) === 'reviews' && segments[4] === caseId) {
      const tenantId = segments[2];
      if (tenantId !== northTenant) return json(route, { error: 'forbidden' }, 403);
      if (request.method() === 'GET') return json(route, reviews);
      if (request.method() === 'POST') {
        if (role !== 'operator') return json(route, { error: 'forbidden' }, 403);
        submissions.push(request.headers()['idempotency-key'] ?? 'missing');
        const body = request.postDataJSON() as { decision: Review['decision']; note?: string };
        const review: Review = { review_id: `synthetic-review-${reviews.length + 1}`, tenant_id: tenantId, case_id: caseId,
          decision: body.decision, actor_issuer: 'https://synthetic-auth.example/', actor_subject: 'synthetic|operator',
          note: body.note ?? null, created_at: reviewTime };
        reviews.push(review);
        return json(route, review, 201);
      }
    }
    if (segments.length === 6 && segments.at(-1) === 'grounded-analysis' && request.method() === 'POST') {
      return json(route, { groundingState: 'INSUFFICIENT_EVIDENCE', caseId, citations: [], humanReviewRequired: true,
        message: 'Available synthetic documents did not provide sufficient evidence.' });
    }
    return json(route, { error: 'not_found' }, 404);
  });
  return { reviews, submissions, requests, unexpectedRequests };
}

test('mocked browser journey keeps abstention visible and renders human review history', async ({ page }) => {
  const api = await installSyntheticApi(page, 'operator');
  await page.goto('/');

  await expect(page.getByText('Local API connected')).toBeVisible();
  await expect(page.getByText('SYNTHETIC-LOGIN-001')).toBeVisible();
  await page.getByRole('button', { name: 'Analyze with grounded documents' }).click();
  await expect(page.getByRole('heading', { name: 'Insufficient evidence' })).toBeVisible();
  await expect(page.getByText('Human review is required. No recommendation was executed and the case was not changed.')).toBeVisible();

  await page.getByRole('button', { name: 'Reject', exact: true }).click();
  await expect(page.getByRole('group', { name: 'Confirm reject decision' })).toBeVisible();
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  expect(api.submissions).toHaveLength(0);

  for (const decision of ['approve', 'reject', 'defer'] as const) {
    await page.getByRole('button', { name: decision[0].toUpperCase() + decision.slice(1), exact: true }).click();
    await expect(page.getByRole('group', { name: `Confirm ${decision} decision` })).toBeVisible();
    expect(api.submissions).toHaveLength(decision === 'approve' ? 0 : decision === 'reject' ? 1 : 2);
    if (decision === 'approve') await page.getByLabel('Optional reviewer note').fill('Synthetic review note');
    await page.getByRole('button', { name: 'Confirm review' }).click();
    await expect(page.getByText('Human review saved.')).toBeVisible();
  }

  await expect(page.getByRole('heading', { name: 'Review history' })).toBeVisible();
  const historyItems = page.locator('.case-review ol li');
  await expect(historyItems).toHaveCount(3);
  await expect(historyItems.nth(0)).toContainText('approve');
  await expect(historyItems.nth(1)).toContainText('reject');
  await expect(historyItems.nth(2)).toContainText('defer');
  await expect(page.locator('.case-review ol')).toContainText('synthetic|operator');
  expect(api.reviews.map((review) => review.decision)).toEqual(['approve', 'reject', 'defer']);
  expect(api.submissions).toHaveLength(3);
  expect(new Set(api.submissions).size).toBe(3);
  expect(api.unexpectedRequests.every((origin) => origin === 'https://fonts.googleapis.com')).toBe(true);
});

test('read-only identity sees history but cannot submit; cross-tenant selection is denied', async ({ page }) => {
  const api = await installSyntheticApi(page, 'reader');
  await page.goto('/?e2e-role=reader');
  await expect(page.getByText('SYNTHETIC-LOGIN-001')).toBeVisible();
  await expect(page.getByText('You can view review history but cannot submit a decision.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Approve', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Show review history' }).click();
  await expect(page.getByRole('heading', { name: 'Review history' })).toBeVisible();
  await expect(page.locator('.case-review ol')).toContainText('defer');
  expect(api.submissions).toEqual([]);

  await page.getByLabel('Requested tenant').selectOption(southTenant);
  await expect(page.getByRole('alert')).toContainText('Access was denied');
  await expect(page.getByText('SYNTHETIC-LOGIN-001')).toHaveCount(0);
  expect(api.unexpectedRequests.every((origin) => origin === 'https://fonts.googleapis.com')).toBe(true);
});

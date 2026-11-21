import { expect, test } from '@playwright/test';
import { env, signIn } from './support';

// A real authenticated browser request must be searchable in Tempo, and its structured log must be retrievable from Loki through the
// same trace identifier. Queries go through Grafana's data-source proxy with the admin credentials from .env.local.
const grafana = `http://localhost:${env.AEGIS_PORT_GRAFANA ?? 3300}`;
const auth = `Basic ${Buffer.from(`aegis-admin:${env.AEGIS_GRAFANA_ADMIN_PASSWORD}`).toString('base64')}`;

async function proxy(path: string): Promise<unknown> {
  const response = await fetch(`${grafana}/api/datasources/proxy/uid/${path}`, { headers: { authorization: auth } });
  return response.json();
}

test('an authenticated browser request is searchable in Tempo and correlated with its Loki log', async ({ page }) => {
  const started = Math.floor(Date.now() / 1000) - 5;
  await signIn(page, 'alice.north');
  await expect(page.getByText('SYNTHETIC-LOGIN-001')).toBeVisible({ timeout: 30_000 });

  // Batches export every few seconds. Poll the backend until the browser-driven route span is stored.
  let traceId: string | null = null;
  await expect.poll(async () => {
    const found = await proxy(`tempo/api/search?q=${encodeURIComponent('{name="GET /api/tenants/:tenantId/cases"}')}&limit=20&start=${started}&end=${Math.floor(Date.now() / 1000) + 60}`) as { traces?: { traceID: string }[] };
    traceId = found.traces?.[0]?.traceID ?? null;
    return traceId;
  }, { timeout: 90_000, intervals: [3000] }).not.toBeNull();

  const trace = await proxy(`tempo/api/traces/${traceId}`) as { batches?: unknown[] };
  expect(JSON.stringify(trace)).toContain('GET /api/tenants/:tenantId/cases');
  expect(JSON.stringify(trace)).not.toMatch(/eyJ[A-Za-z0-9_-]{10,}\./);

  const logs = await proxy(`loki/loki/api/v1/query_range?query=${encodeURIComponent(`{service_name="aegis-api"} | trace_id="${traceId}"`)}&limit=20&start=${started * 1e9}`) as { data?: { result?: unknown[] } };
  expect(logs.data?.result?.length ?? 0).toBeGreaterThan(0);
});

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from './app.js';
import type { Pool } from 'pg';

const servers: Array<ReturnType<typeof createApp>> = [];
function createTestApp() { const app = createApp(); servers.push(app); return app; }
afterEach(async () => { await Promise.all(servers.splice(0).map((app) => app.close())); });

describe('Aegis API', () => {
  it('provides a health endpoint', async () => {
    const reply = await createTestApp().inject({ method: 'GET', url: '/api/health' });
    expect(reply.statusCode).toBe(200);
    expect(reply.json()).toMatchObject({ ok: true, mode: 'starter' });
  });
  it('returns a clearly marked synthetic answer', async () => {
    const reply = await createTestApp().inject({
      method: 'POST', url: '/api/demo/query', payload: { question: 'What is the login incident process?' },
    });
    expect(reply.statusCode).toBe(200);
    expect(reply.json().mode).toBe('synthetic-mock');
    expect(reply.json().citations[0].documentId).toBe('SYNTHETIC-POLICY-001');
  });
  it('rejects blank and overly long questions', async () => {
    const app = createTestApp();
    for (const question of ['', 'a'.repeat(501)]) {
      const reply = await app.inject({ method: 'POST', url: '/api/demo/query', payload: { question } });
      expect(reply.statusCode).toBe(400);
    }
  });

  it('passes startup role verification and exposes review routes without opening a listener', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ safe: true }] });
    const end = vi.fn().mockResolvedValue(undefined);
    const pool = { query, end } as unknown as Pool;
    const app = createApp({ authConfig: { issuer: 'https://synthetic.auth0.example/',
      audience: 'https://aegis.synthetic.example/api', databaseUrl: 'postgres://localhost/aegis_test' },
    testDependencies: { pool } });

    try {
      await app.ready();
      expect(query).toHaveBeenCalledOnce();
      expect(app.printRoutes()).toContain('reviews (GET, HEAD, POST)');
      const reply = await app.inject({ method: 'GET',
        url: '/api/tenants/10000000-0000-4000-8000-000000000001/cases/00000000-0000-4000-8000-000000000001/reviews' });
      expect(reply.statusCode).toBe(401);
    } finally {
      await app.close();
    }
    expect(end).toHaveBeenCalledOnce();
  });
});

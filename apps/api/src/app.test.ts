import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from './app.js';

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
});

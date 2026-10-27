import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from './app.js';
import { syntheticCases } from './contracts/triage.js';
import { triageCase } from './triage.js';

const servers: Array<ReturnType<typeof createApp>> = [];
function testApp() { const app = createApp(); servers.push(app); return app; }
afterEach(async () => { await Promise.all(servers.splice(0).map((app) => app.close())); vi.unstubAllEnvs(); });
const url = '/api/demo/triage';

describe('triage API integration', () => {
  it.each(syntheticCases)('returns the exact fixed recommendation for $id', async ({ id }) => {
    const app = testApp();
    const reply = await app.inject({ method: 'POST', url, payload: { caseId: id } });
    expect(reply.statusCode).toBe(200);
    expect(reply.json()).toEqual(triageCase(id));
    const again = await app.inject({ method: 'POST', url, payload: { caseId: id } });
    expect(again.body).toBe(reply.body);
  });

  it.each([
    {}, { caseId: 'unknown' }, { caseId: 1 }, { caseId: true }, { caseId: ['SYNTHETIC-LOGIN-001'] },
    { caseId: null }, { caseId: '' }, { caseId: 'SYNTHETIC-LOGIN-001', privateNote: 'DO-NOT-ECHO' },
    [], 'text', null,
  ])('rejects unsupported JSON %j without disclosure', async (body) => {
    const reply = await testApp().inject({ method: 'POST', url, headers: { 'content-type': 'application/json' }, payload: JSON.stringify(body) });
    expect(reply.statusCode).toBe(400);
    expect(reply.json()).toEqual({ error: 'Choose one supported synthetic case.' });
    expect(reply.body).not.toContain('DO-NOT-ECHO');
  });

  it.each(['{broken', ''])('sanitizes malformed or empty JSON', async (payload) => {
    const reply = await testApp().inject({ method: 'POST', url, headers: { 'content-type': 'application/json' }, payload });
    expect(reply.statusCode).toBe(400);
    expect(reply.json()).toEqual({ error: 'Choose one supported synthetic case.' });
  });

  it('rejects unsupported content types', async () => {
    const reply = await testApp().inject({ method: 'POST', url, headers: { 'content-type': 'application/xml' }, payload: '<secret>DO-NOT-ECHO</secret>' });
    expect(reply.statusCode).toBe(415);
    expect(reply.json()).toEqual({ error: 'Use an application/json request.' });
  });

  it('limits request bytes before processing', async () => {
    const reply = await testApp().inject({ method: 'POST', url, payload: { caseId: 'a'.repeat(1100) } });
    expect(reply.statusCode).toBe(413);
    expect(reply.json()).toEqual({ error: 'Request is too large.' });
  });

  it('sanitizes unexpected server exceptions', async () => {
    const app = testApp();
    app.addHook('preHandler', async () => { throw new Error('INTERNAL-DETAIL-DO-NOT-ECHO'); });
    const reply = await app.inject({ method: 'POST', url, payload: { caseId: syntheticCases[0].id } });
    expect(reply.statusCode).toBe(500);
    expect(reply.json()).toEqual({ error: 'Triage is unavailable. Please retry.' });
  });

  it('does not register either demo endpoint in production', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    const app = testApp();
    for (const path of [url, '/api/demo/query']) {
      expect((await app.inject({ method: 'POST', url: path, payload: { caseId: syntheticCases[0].id } })).statusCode).toBe(404);
    }
    expect((await app.inject({ method: 'GET', url: '/api/health' })).statusCode).toBe(200);
  });
});

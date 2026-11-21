import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { AuthorizationError, type VerifiedPrincipal } from '../auth/token.js';
import { createWorkflowMetrics } from '../workflow/workflow-metrics.js';
import { METRICS_PATH, metricsEndpointEnabled, registerMetricsRoute } from './metrics-endpoint.js';

const issuer = 'https://issuer.example.test/';
const observer: VerifiedPrincipal = { issuer, subject: 'ops-1', scopes: new Set(['observe:metrics']) };
const reader: VerifiedPrincipal = { issuer, subject: 'reader-1', scopes: new Set(['read:cases', 'write:cases']) };
const verify = async (authorization: string | undefined): Promise<VerifiedPrincipal> => {
  if (authorization === 'Bearer observer') return observer;
  if (authorization === 'Bearer reader') return reader;
  throw new AuthorizationError(401);
};

async function app() {
  const metrics = createWorkflowMetrics();
  metrics.recordAttempt({ outcome: 'succeeded', durationMs: 20 });
  const server = Fastify();
  await server.register(async (scoped) => registerMetricsRoute(scoped, verify, metrics));
  await server.ready();
  return server;
}

describe('metrics endpoint enablement', () => {
  it('is off unless AEGIS_METRICS_ENDPOINT is exactly "enabled"', () => {
    expect(metricsEndpointEnabled({})).toBe(false);
    expect(metricsEndpointEnabled({ AEGIS_METRICS_ENDPOINT: '1' })).toBe(false);
    expect(metricsEndpointEnabled({ AEGIS_METRICS_ENDPOINT: 'true' })).toBe(false);
    expect(metricsEndpointEnabled({ AEGIS_METRICS_ENDPOINT: 'enabled' })).toBe(true);
  });
});

describe('metrics endpoint permission boundary', () => {
  it('refuses an unauthenticated request with 401 and a bearer challenge', async () => {
    const server = await app();
    try {
      const response = await server.inject({ method: 'GET', url: METRICS_PATH });
      expect(response.statusCode).toBe(401);
      expect(response.headers['www-authenticate']).toBe('Bearer');
    } finally { await server.close(); }
  });

  it('refuses read and write permissions, which do not grant observation', async () => {
    const server = await app();
    try {
      const response = await server.inject({ method: 'GET', url: METRICS_PATH, headers: { authorization: 'Bearer reader' } });
      expect(response.statusCode).toBe(403);
      expect(response.body).not.toContain('aegis_workflow_attempts_total');
    } finally { await server.close(); }
  });

  it('serves Prometheus text to the observe:metrics permission, with no-store caching', async () => {
    const server = await app();
    try {
      const response = await server.inject({ method: 'GET', url: METRICS_PATH, headers: { authorization: 'Bearer observer' } });
      expect(response.statusCode).toBe(200);
      expect(response.headers['content-type']).toContain('text/plain');
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.body).toContain('aegis_workflow_attempts_total{outcome="succeeded"} 1');
    } finally { await server.close(); }
  });

  it('exposes only fixed metric names, with no tenant or execution identifiers', async () => {
    const server = await app();
    try {
      const body = (await server.inject({ method: 'GET', url: METRICS_PATH, headers: { authorization: 'Bearer observer' } })).body;
      expect(body).not.toMatch(/tenant|execution|correlation|case/i);
    } finally { await server.close(); }
  });
});

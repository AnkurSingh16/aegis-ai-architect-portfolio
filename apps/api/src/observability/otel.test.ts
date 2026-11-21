import { describe, expect, it, vi } from 'vitest';
import { AllowlistSpanExporter, SPAN_ATTRIBUTE_ALLOWLIST, allowlistAttributes, validateCollectorEndpoint } from './otel.js';

describe('telemetry attribute allowlist', () => {
  it('keeps operation and route attributes and drops anything else', () => {
    const kept = allowlistAttributes({ 'http.route': '/api/tenants/:tenantId/cases', 'http.request.method': 'GET',
      'db.system.name': 'postgresql', 'url.full': 'http://x/?token=abc', 'db.statement': 'SELECT * FROM aegis.memberships',
      'user.id': 'subject-123', 'http.request.header.authorization': 'Bearer eyJ' });
    expect(kept).toEqual({ 'http.route': '/api/tenants/:tenantId/cases', 'http.request.method': 'GET', 'db.system.name': 'postgresql' });
  });

  it('never allows identity, credential, query or SQL attributes', () => {
    for (const forbidden of ['url.full', 'url.query', 'http.target', 'db.statement', 'user.id', 'enduser.id', 'authorization', 'http.request.header.authorization', 'exception.message']) {
      expect(SPAN_ATTRIBUTE_ALLOWLIST.has(forbidden)).toBe(false);
    }
  });

  it('filters attributes and clears events before the inner exporter sees a span', () => {
    const inner = { export: vi.fn((spans: unknown[], callback: (r: { code: number }) => void) => callback({ code: 0 })), shutdown: async () => undefined };
    const exporter = new AllowlistSpanExporter(inner);
    const span = { attributes: { 'http.route': '/r', 'url.full': 'http://x/?t=1' }, events: [{ name: 'exception', attributes: { 'exception.message': 'secret detail' } }] };
    exporter.export([span], () => undefined);
    expect(inner.export).toHaveBeenCalledOnce();
    expect(span.attributes).toEqual({ 'http.route': '/r' });
    expect(span.events).toEqual([]);
  });
});

describe('collector endpoint rule', () => {
  const local = { AEGIS_ENVIRONMENT: 'local', AEGIS_ALLOWED_SERVICE_HOSTS: 'otel-collector' };
  it('accepts the named local collector and loopback in a local deployment', () => {
    expect(validateCollectorEndpoint('http://otel-collector:4318', local)).toBe('http://otel-collector:4318');
    expect(validateCollectorEndpoint('http://127.0.0.1:4318', local)).toBe('http://127.0.0.1:4318');
  });
  it('refuses external hosts in every scheme and outside a local deployment', () => {
    expect(() => validateCollectorEndpoint('https://collector.example.com/v1', local)).toThrow('Invalid telemetry configuration.');
    expect(() => validateCollectorEndpoint('http://collector.example.com:4318', local)).toThrow();
    expect(() => validateCollectorEndpoint('http://otel-collector:4318', { AEGIS_ENVIRONMENT: 'production', AEGIS_ALLOWED_SERVICE_HOSTS: 'otel-collector' })).toThrow();
    expect(() => validateCollectorEndpoint('http://user:pw@127.0.0.1:4318', local)).toThrow();
  });
});

import { describe, expect, it } from 'vitest';
import { filterLogFields, LOG_ATTRIBUTE_ALLOWLIST } from './log.js';
import { assertSingleTracingExporter } from './otel.js';

describe('structured log allowlist', () => {
  it('keeps only allowlisted fields', () => {
    expect(filterLogFields({ outcome: 'success', 'http.route': '/api/x', subject: 'user-123', token: 'eyJabc.def.ghi', query: 'refund' }))
      .toEqual({ outcome: 'success', 'http.route': '/api/x' });
  });

  it('never allows identity, credential, query, body or SQL keys', () => {
    for (const key of ['sub', 'subject', 'user.id', 'enduser.id', 'authorization', 'token', 'query', 'body', 'db.statement', 'url.full', 'email']) {
      expect(LOG_ATTRIBUTE_ALLOWLIST.has(key)).toBe(false);
    }
  });

  it('bounds the length of kept string values', () => {
    const kept = filterLogFields({ reason: 'x'.repeat(500) });
    expect(String(kept.reason).length).toBe(120);
  });
});

describe('single tracing exporter', () => {
  it('refuses the hand-written exporter and the SDK at the same time', () => {
    expect(() => assertSingleTracingExporter({ AEGIS_TRACING: 'enabled', AEGIS_OTEL_ENABLED: '1' })).toThrow('one tracing exporter');
  });
  it('allows either one alone', () => {
    expect(() => assertSingleTracingExporter({ AEGIS_TRACING: 'enabled' })).not.toThrow();
    expect(() => assertSingleTracingExporter({ AEGIS_OTEL_ENABLED: '1' })).not.toThrow();
    expect(() => assertSingleTracingExporter({})).not.toThrow();
  });
});

import { describe, expect, it } from 'vitest';
import { assertLoopbackEndpoint, buildSpan, createOtlpExporter, newTraceId, sanitiseAttributes, tracingFromEnv } from './tracing.js';

const SENTINEL = 'SENTINEL-TRACE-PAYLOAD-7f3a';

describe('tracing is off unless explicitly configured', () => {
  it('returns no exporter without AEGIS_TRACING=enabled, even with an endpoint', () => {
    expect(tracingFromEnv({})).toBeNull();
    expect(tracingFromEnv({ AEGIS_OTLP_ENDPOINT: 'http://127.0.0.1:4318' })).toBeNull();
    expect(tracingFromEnv({ AEGIS_TRACING: 'enabled' })).toBeNull();
    expect(tracingFromEnv({ AEGIS_TRACING: '1', AEGIS_OTLP_ENDPOINT: 'http://127.0.0.1:4318' })).toBeNull();
  });

  it('returns an exporter when both are set', () => {
    expect(tracingFromEnv({ AEGIS_TRACING: 'enabled', AEGIS_OTLP_ENDPOINT: 'http://127.0.0.1:4318' })).not.toBeNull();
  });
});

describe('endpoint must be loopback', () => {
  it('accepts loopback hosts and rejects remote hosts, other schemes and junk', () => {
    expect(assertLoopbackEndpoint('http://127.0.0.1:4318').hostname).toBe('127.0.0.1');
    expect(assertLoopbackEndpoint('http://localhost:4318').hostname).toBe('localhost');
    expect(() => assertLoopbackEndpoint('https://collector.example.com')).toThrow(/loopback/);
    expect(() => assertLoopbackEndpoint('ftp://127.0.0.1')).toThrow(/http or https/);
    expect(() => assertLoopbackEndpoint('not a url')).toThrow(/valid URL/);
  });
});

describe('attributes are allowlisted and sanitised', () => {
  it('keeps allowed keys and drops case text, arguments, actors, reasons and free text', () => {
    const out = sanitiseAttributes({
      outcome: 'succeeded', attempt: 1, durationMs: 12.5, caseId: 'SYNTHETIC-LOGIN-001', args: { q: SENTINEL },
      actor: 'someone@example.com', reason: SENTINEL, errorMessage: SENTINEL,
    });
    expect(out).toEqual({ outcome: 'succeeded', attempt: 1, durationMs: 12.5 });
    expect(JSON.stringify(out)).not.toContain(SENTINEL);
  });

  it('refuses free-text values even under an allowed key', () => {
    expect(sanitiseAttributes({ outcome: 'a sentence with spaces', errorClass: SENTINEL.repeat(4) })).toEqual({});
  });
});

describe('export', () => {
  it('posts OTLP JSON with the trace id and the allowlisted attributes only', async () => {
    const calls: { url: string; body: string }[] = [];
    const exporter = createOtlpExporter('http://127.0.0.1:4318', 'aegis-api', async (url, init) => { calls.push({ url, body: init.body }); return {}; });
    const traceId = newTraceId('4bf92f3577b34da6a3ce929d0e0e4736');
    exporter.export(buildSpan('workflow.triage', traceId, 1000, 1012.5, { outcome: 'succeeded', caseId: SENTINEL, durationMs: 12.5 }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('http://127.0.0.1:4318/v1/traces');
    expect(calls[0]!.body).toContain('4bf92f3577b34da6a3ce929d0e0e4736');
    expect(calls[0]!.body).toContain('workflow.triage');
    expect(calls[0]!.body).not.toContain(SENTINEL);
  });

  it('ignores an export failure instead of throwing', async () => {
    const exporter = createOtlpExporter('http://127.0.0.1:4318', 'aegis-api', async () => { throw new Error('collector down'); });
    expect(() => exporter.export(buildSpan('workflow.triage', newTraceId(null), 0, 1, {}))).not.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it('generates a 32-hex trace id when the request carried none', () => {
    expect(newTraceId(null)).toMatch(/^[0-9a-f]{32}$/);
  });
});

import { randomBytes } from 'node:crypto';

/**
 * Span export in OTLP/HTTP JSON, with no third-party SDK. Disabled unless AEGIS_TRACING is exactly "enabled" AND
 * AEGIS_OTLP_ENDPOINT is set. The endpoint must be a loopback address; a remote collector needs a separate decision.
 *
 * Sensitive data: only the allowlisted attribute names below are exported, and string values must be short identifier-like
 * tokens. Case text, questions, answers, arguments, actor names, reasons and error messages are never exported.
 * An export failure is swallowed: tracing never changes a request's outcome.
 */
export const TRACING_ENV = 'AEGIS_TRACING' as const;
export const OTLP_ENDPOINT_ENV = 'AEGIS_OTLP_ENDPOINT' as const;

export const SPAN_ATTRIBUTE_ALLOWLIST = ['outcome', 'attempt', 'errorClass', 'durationMs', 'workflow', 'stepCount'] as const;
const IDENTIFIER = /^[A-Za-z0-9._:-]{1,64}$/;

export type SpanAttributeValue = string | number | boolean;
export interface SpanRecord {
  readonly name: string;
  readonly traceId: string;
  readonly spanId: string;
  readonly startUnixNano: string;
  readonly endUnixNano: string;
  readonly attributes: Readonly<Record<string, SpanAttributeValue>>;
}
export interface SpanSink { export(span: SpanRecord): void }

/** Keeps allowlisted keys with safe values only. Everything else is dropped silently. */
export function sanitiseAttributes(input: Readonly<Record<string, unknown>>): Record<string, SpanAttributeValue> {
  const out: Record<string, SpanAttributeValue> = {};
  for (const key of SPAN_ATTRIBUTE_ALLOWLIST) {
    const value = input[key];
    if (typeof value === 'number' && Number.isFinite(value)) out[key] = value;
    else if (typeof value === 'boolean') out[key] = value;
    else if (typeof value === 'string' && IDENTIFIER.test(value)) out[key] = value;
  }
  return out;
}

const LOOPBACK = /^(127\.0\.0\.1|localhost|\[::1\])$/;

export function assertLoopbackEndpoint(endpoint: string): URL {
  let url: URL;
  try { url = new URL(endpoint); } catch { throw new Error('OTLP endpoint is not a valid URL'); }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('OTLP endpoint must use http or https');
  if (!LOOPBACK.test(url.hostname)) throw new Error('OTLP endpoint must be a loopback address');
  return url;
}

type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal }) => Promise<unknown>;

export function createOtlpExporter(endpoint: string, serviceName: string, fetchImpl: FetchLike = fetch as unknown as FetchLike): SpanSink {
  const url = assertLoopbackEndpoint(endpoint);
  const target = `${url.origin}/v1/traces`;
  return {
    export(span) {
      const body = JSON.stringify({
        resourceSpans: [{
          resource: { attributes: [{ key: 'service.name', value: { stringValue: serviceName } }] },
          scopeSpans: [{
            scope: { name: 'aegis.workflow' },
            spans: [{
              traceId: span.traceId, spanId: span.spanId, name: span.name, kind: 1,
              startTimeUnixNano: span.startUnixNano, endTimeUnixNano: span.endUnixNano,
              attributes: Object.entries(span.attributes).map(([key, value]) => ({
                key, value: typeof value === 'number' ? { doubleValue: value } : typeof value === 'boolean' ? { boolValue: value } : { stringValue: value },
              })),
            }],
          }],
        }],
      });
      // Fire and forget. A failed export is ignored; it must not affect the request.
      Promise.resolve()
        .then(() => fetchImpl(target, { method: 'POST', headers: { 'content-type': 'application/json' }, body, signal: AbortSignal.timeout(2000) }))
        .catch(() => undefined);
    },
  };
}

/** Returns an exporter only when both settings are present. Otherwise null, so nothing is exported. */
export function tracingFromEnv(env: NodeJS.ProcessEnv, fetchImpl?: FetchLike): SpanSink | null {
  if (env[TRACING_ENV] !== 'enabled') return null;
  const endpoint = env[OTLP_ENDPOINT_ENV];
  if (!endpoint) return null;
  return createOtlpExporter(endpoint, 'aegis-api', fetchImpl);
}

export function newTraceId(parent: string | null): string {
  return parent ?? randomBytes(16).toString('hex');
}

/** Builds a span from start and end times in milliseconds. Attributes pass the allowlist. */
export function buildSpan(name: string, traceId: string, startMs: number, endMs: number, attributes: Readonly<Record<string, unknown>>): SpanRecord {
  return {
    name, traceId, spanId: randomBytes(8).toString('hex'),
    startUnixNano: String(Math.round(startMs * 1_000_000)), endUnixNano: String(Math.round(endMs * 1_000_000)),
    attributes: sanitiseAttributes(attributes),
  };
}

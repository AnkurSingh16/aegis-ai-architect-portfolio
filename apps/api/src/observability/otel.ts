import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { FastifyInstrumentation } from '@opentelemetry/instrumentation-fastify';
import { PgInstrumentation } from '@opentelemetry/instrumentation-pg';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { ATTR_SERVICE_NAME } from '@opentelemetry/semantic-conventions';

/**
 * OpenTelemetry for the API, through the official SDK and the OTLP/HTTP exporters. Disabled unless AEGIS_OTEL_ENABLED=1.
 *
 * The export path is restricted to the local collector or to an explicitly listed local service host, so telemetry cannot be sent to an
 * arbitrary destination. Every span passes an attribute allowlist before export: credentials, token values, subjects, query text,
 * arguments, full URLs and SQL text are never exported, even if an instrumentation adds them.
 */

const LOOPBACK = ['localhost', '127.0.0.1', '[::1]'];

/** Span attributes that may leave the process. Anything else is removed before export. */
export const SPAN_ATTRIBUTE_ALLOWLIST: ReadonlySet<string> = new Set([
  'http.request.method', 'http.method', 'http.route', 'http.response.status_code', 'http.status_code',
  'network.protocol.version', 'url.scheme', 'server.address', 'server.port',
  'db.system', 'db.system.name', 'db.operation', 'db.operation.name', 'db.collection.name', 'db.namespace', 'db.name',
  'error.type', 'aegis.identity.outcome', 'aegis.operation',
]);

/** Keeps only allowlisted attributes. Exported for tests. */
export function allowlistAttributes(attributes: Record<string, unknown>): Record<string, unknown> {
  const kept: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(attributes)) {
    if (SPAN_ATTRIBUTE_ALLOWLIST.has(key)) kept[key] = value;
  }
  return kept;
}

/** The parts of a finished span and of an exporter that this module uses. Declared here so no unpinned transitive package is imported. */
export interface FinishedSpanLike { attributes: Record<string, unknown>; events: unknown[] }
export interface SpanExporterLike {
  export(spans: FinishedSpanLike[], resultCallback: (result: { code: number }) => void): void;
  shutdown(): Promise<void>;
  forceFlush?(): Promise<void>;
}

/** Wraps an exporter so that each span's attributes are filtered before the wrapped exporter sees them. */
export class AllowlistSpanExporter implements SpanExporterLike {
  constructor(private readonly inner: SpanExporterLike) {}

  export(spans: FinishedSpanLike[], resultCallback: (result: { code: number }) => void): void {
    for (const span of spans) {
      for (const key of Object.keys(span.attributes)) {
        if (!SPAN_ATTRIBUTE_ALLOWLIST.has(key)) delete span.attributes[key];
      }
      // Events can carry messages and exception text. None is exported.
      span.events = [];
    }
    this.inner.export(spans, resultCallback);
  }

  shutdown(): Promise<void> {
    return this.inner.shutdown();
  }

  forceFlush(): Promise<void> {
    return this.inner.forceFlush?.() ?? Promise.resolve();
  }
}

/** The collector endpoint must be a local destination in a local deployment. An external host is refused in every case. */
export function validateCollectorEndpoint(value: string, env: NodeJS.ProcessEnv): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('Invalid telemetry configuration.'); }
  const named = (env.AEGIS_ALLOWED_SERVICE_HOSTS ?? '').split(',').map((name) => name.trim()).filter(Boolean);
  // Local only: loopback, or a named service that the deployment lists. Any other host is refused, whatever the scheme.
  const local = LOOPBACK.includes(url.hostname) || named.includes(url.hostname);
  const allowed = env.AEGIS_ENVIRONMENT === 'local' && local && (url.protocol === 'http:' || url.protocol === 'https:');
  if (!allowed || url.username || url.password || url.search || url.hash) throw new Error('Invalid telemetry configuration.');
  return value;
}

let sdk: NodeSDK | undefined;

/** Starts telemetry when enabled. Must run before the application modules are imported (see register.ts). */
export function startTelemetry(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.AEGIS_OTEL_ENABLED !== '1' || sdk) return false;
  const endpoint = validateCollectorEndpoint(env.OTEL_EXPORTER_OTLP_ENDPOINT ?? 'http://127.0.0.1:4318', env);
  const traceExporter = new AllowlistSpanExporter(new OTLPTraceExporter({ url: `${endpoint.replace(/\/$/, '')}/v1/traces` }) as unknown as SpanExporterLike);
  sdk = new NodeSDK({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: 'aegis-api',
      'deployment.environment.name': env.AEGIS_ENVIRONMENT ?? 'unset',
    }),
    traceExporter,
    metricReaders: [new PeriodicExportingMetricReader({
      exporter: new OTLPMetricExporter({ url: `${endpoint.replace(/\/$/, '')}/v1/metrics` }),
      exportIntervalMillis: 5000,
    })],
    instrumentations: [
      new HttpInstrumentation({ ignoreIncomingRequestHook: (request) => request.url === '/api/health' }),
      new FastifyInstrumentation(),
      new PgInstrumentation({ enhancedDatabaseReporting: false }),
    ],
  });
  sdk.start();
  return true;
}

export async function stopTelemetry(): Promise<void> {
  if (!sdk) return;
  const current = sdk;
  sdk = undefined;
  await current.shutdown();
}

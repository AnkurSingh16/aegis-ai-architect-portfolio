import { trace } from '@opentelemetry/api';
import { logs, SeverityNumber } from '@opentelemetry/api-logs';

/**
 * Structured application logs. Each event is written two ways:
 * - as a JSON line on stdout (Docker keeps it for local inspection), and
 * - as an OpenTelemetry log record, which the SDK exports to the Collector and from there to Loki. The record takes the trace and span
 *   identifiers from the active span, so a log line can be joined to its trace.
 *
 * Only allowlisted fields are kept. A caller cannot add a subject, token, header, query, body or SQL text by passing it in, because
 * anything outside the allowlist is dropped before either output.
 */

/** Log attributes that may leave the process. Keys are exact; values are short, bounded, and never identify a person. */
export const LOG_ATTRIBUTE_ALLOWLIST: ReadonlySet<string> = new Set([
  'outcome', 'code', 'reason', 'requestId', 'http.route', 'http.response.status_code', 'aegis.identity.outcome', 'aegis.operation',
  'database.status', 'readiness.reason', 'readiness.migrations_applied', 'readiness.migrations_expected',
]);

const MAX_VALUE_LENGTH = 120;

export function filterLogFields(fields: Record<string, string | number | boolean>): Record<string, string | number | boolean> {
  const kept: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (!LOG_ATTRIBUTE_ALLOWLIST.has(key)) continue;
    kept[key] = typeof value === 'string' ? value.slice(0, MAX_VALUE_LENGTH) : value;
  }
  return kept;
}

export function traceContext(): { trace_id?: string; span_id?: string } {
  const context = trace.getActiveSpan()?.spanContext();
  return context ? { trace_id: context.traceId, span_id: context.spanId } : {};
}

export function logEvent(event: string, fields: Record<string, string | number | boolean>): void {
  const safe = filterLogFields(fields);
  process.stdout.write(`${JSON.stringify({ event, ...safe, ...traceContext() })}\n`);
  logs.getLogger('aegis-api').emit({
    severityNumber: SeverityNumber.INFO,
    severityText: 'INFO',
    body: event,
    attributes: { 'event.name': event, ...safe },
  });
}

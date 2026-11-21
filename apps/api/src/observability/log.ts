import { trace } from '@opentelemetry/api';

/**
 * Structured JSON log lines that carry the active trace and span identifiers, so a log line can be joined to its trace. Only the
 * fields passed by the caller are written; this helper never adds a request body, header, token or subject.
 */
export function traceContext(): { trace_id?: string; span_id?: string } {
  const context = trace.getActiveSpan()?.spanContext();
  return context ? { trace_id: context.traceId, span_id: context.spanId } : {};
}

export function logEvent(event: string, fields: Record<string, string | number | boolean>): void {
  process.stdout.write(`${JSON.stringify({ event, ...fields, ...traceContext() })}\n`);
}

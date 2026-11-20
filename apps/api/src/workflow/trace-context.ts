/**
 * W3C trace-context (traceparent) parsing. Pure. It reads only the trace id, which is then recorded on driver log lines so an
 * operator can join them to an upstream trace. It does not start, export or propagate spans; that needs an exporter, which is
 * a separate decision.
 */
const TRACEPARENT = /^00-([0-9a-f]{32})-([0-9a-f]{16})-[0-9a-f]{2}$/;

/** Returns the trace id from a valid traceparent header, or null. All-zero ids are invalid under the W3C specification. */
export function parseTraceparent(header: string | undefined): string | null {
  if (typeof header !== 'string') return null;
  const match = TRACEPARENT.exec(header.trim());
  if (!match) return null;
  const [, traceId, parentId] = match;
  if (/^0+$/.test(traceId!) || /^0+$/.test(parentId!)) return null;
  return traceId!;
}

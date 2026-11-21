import { createHash } from 'node:crypto';

/**
 * Structured audit events for MCP tool calls. An event records who (as a digest), which tool, which tenant, what decision, the
 * deny reasons, and a duration. It never records arguments, query text, tool output, bearer tokens or raw subject identifiers.
 * The only free-form detail allowed is a small set of numeric facts (for example, the query length), by name.
 */
export type McpOutcome = 'allowed' | 'denied' | 'error' | 'unauthenticated' | 'not_a_member' | 'invalid_input';

export interface McpAuditEvent {
  readonly event: 'mcp.tool_call';
  readonly at: string;
  readonly requestRef: string;
  readonly tool: string;
  readonly tenantId: string | null;
  readonly subjectRef: string | null;
  readonly outcome: McpOutcome;
  readonly reasons: readonly string[];
  readonly durationMs: number;
  readonly detail?: Readonly<Record<string, number>>;
}

export interface McpAuditSink {
  record(event: McpAuditEvent): void;
}

/** Keys that may appear in `detail`. Anything else is dropped before the event leaves this module. */
export const AUDIT_DETAIL_KEYS = ['queryLength', 'resultCount'] as const;

/** A short, stable reference to a subject. The raw subject is never written to an audit event. */
export function subjectRef(subject: string): string {
  return createHash('sha256').update(subject, 'utf8').digest('hex').slice(0, 12);
}

export function sanitiseDetail(detail: Readonly<Record<string, unknown>> | undefined): Record<string, number> | undefined {
  if (detail === undefined) return undefined;
  const out: Record<string, number> = {};
  for (const key of AUDIT_DETAIL_KEYS) {
    const value = detail[key];
    if (typeof value === 'number' && Number.isInteger(value) && value >= 0) out[key] = value;
  }
  return Object.keys(out).length === 0 ? undefined : out;
}

/** Writes each event as one JSON line to stderr. Standard output is reserved for the MCP protocol on the stdio transport. */
export function stderrAuditSink(): McpAuditSink {
  return {
    record(event) {
      process.stderr.write(`${JSON.stringify(event)}\n`);
    },
  };
}

/** Keeps events in memory, for tests and for the local demonstration. */
export function memoryAuditSink(): McpAuditSink & { readonly events: McpAuditEvent[] } {
  const events: McpAuditEvent[] = [];
  return { events, record(event) { events.push(event); } };
}

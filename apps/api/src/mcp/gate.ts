import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { AdmissionController } from './admission.js';
import type { McpAuditSink, McpOutcome } from './audit.js';
import type { McpToolSpec } from './tools.js';

/**
 * Pre-dispatch gate for incoming JSON-RPC messages.
 *
 * The MCP SDK validates tool arguments before our callback runs, so a rejected call never reaches the audit code. This gate sits
 * in front of the SDK for `tools/call` requests only. It admits or refuses each call, validates the arguments with the same strict
 * schema the tool advertises, and audits every refusal. A refused call gets a generic, model-visible message that never repeats the
 * submitted values. Admitted calls go to the SDK unchanged, and the gateway audit runs as before.
 *
 * The gate only ever refuses. It never adds a permission, changes a tenant or identity, or alters an admitted message.
 * It must be installed after `server.connect()` returns, because the SDK calls any earlier handler and then processes the message
 * regardless. The server wrapper in server.ts is the only way to connect, so callers cannot skip it.
 */

export interface ValidationDiagnostic {
  readonly tool: string;
  readonly issues: readonly { readonly path: string; readonly code: string }[];
}

export interface GateOptions {
  readonly tools: ReadonlyMap<string, McpToolSpec>;
  readonly admission: AdmissionController;
  readonly audit: McpAuditSink;
  readonly tenantId: string;
  readonly now: () => Date;
  /** Development-only detail, off unless the caller passes it. Carries field paths and codes, never values. */
  readonly diagnostics?: (event: ValidationDiagnostic) => void;
}

/** Minimal shape of the SDK transport that the gate needs. */
export interface GuardableTransport {
  onmessage?: (message: unknown, extra?: unknown) => void;
  send(message: unknown, options?: unknown): Promise<void>;
}

const CALL_PARAMS = z.object({
  name: z.string().min(1).max(200),
  arguments: z.record(z.unknown()).optional(),
}).passthrough();

const GENERIC_INVALID = 'Invalid request.';
const GENERIC_THROTTLED = 'Too many requests. Please retry later.';
/** A slot is released if the SDK never answers, so a lost response cannot exhaust admission. */
const PENDING_TIMEOUT_MS = 60_000;
const MAX_DIAGNOSTIC_ISSUES = 10;

interface Pending {
  readonly release: () => void;
  readonly timer: NodeJS.Timeout;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const isToolCallRequest = (message: unknown): message is { id: string | number; method: 'tools/call'; params?: unknown } =>
  isRecord(message) && message.method === 'tools/call' && (typeof message.id === 'string' || typeof message.id === 'number');
const isResponse = (message: unknown): message is { id: string | number } =>
  isRecord(message) && !('method' in message) && (typeof message.id === 'string' || typeof message.id === 'number')
  && ('result' in message || 'error' in message);

/** Keeps a diagnostic path to a short, plain token. Field names only; nothing a caller sent as a value. */
function safePath(path: readonly (string | number)[]): string {
  return path.map(String).join('.').replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 64);
}

function resultMessage(id: string | number, text: string): unknown {
  return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }], isError: true } };
}

/**
 * Installs the gate on a transport that the SDK is already connected to. Returns nothing. Refused calls get a model-visible tool error,
 * and every refusal writes one audit event with no argument values.
 */
export function guardTransport(transport: GuardableTransport, options: GateOptions): void {
  const sdkOnMessage = transport.onmessage;
  const sdkSend = transport.send.bind(transport);
  const pending = new Map<string | number, Pending>();

  const audit = (outcome: McpOutcome, tool: string, reasons: readonly string[], issueCount?: number) => {
    options.audit.record({
      event: 'mcp.tool_call', at: options.now().toISOString(), requestRef: randomUUID(), tool, tenantId: options.tenantId,
      subjectRef: null, outcome, reasons, durationMs: 0,
      ...(issueCount === undefined ? {} : { detail: { issueCount } }),
    });
  };

  // Responses from the SDK release the admission slot their request reserved.
  transport.send = (message: unknown, sendOptions?: unknown) => {
    if (isResponse(message)) {
      const entry = pending.get(message.id);
      if (entry) {
        clearTimeout(entry.timer);
        entry.release();
        pending.delete(message.id);
      }
    }
    return sdkSend(message, sendOptions);
  };

  transport.onmessage = (message: unknown, extra?: unknown) => {
    if (!isToolCallRequest(message)) {
      sdkOnMessage?.(message, extra);
      return;
    }
    const id = message.id;

    // 1. Admission, before any parsing, verification, database or gateway work.
    const decision = options.admission.admit(options.now());
    if (!decision.admitted) {
      audit('throttled', 'unregistered', [decision.reason]);
      void sdkSend(resultMessage(id, GENERIC_THROTTLED));
      return;
    }

    const refuse = (outcome: McpOutcome, tool: string, reasons: readonly string[], issueCount?: number) => {
      decision.release();
      audit(outcome, tool, reasons, issueCount);
      void sdkSend(resultMessage(id, GENERIC_INVALID));
    };

    // 2. Shape of the call.
    const params = CALL_PARAMS.safeParse(message.params);
    if (!params.success) {
      refuse('invalid_input', 'unregistered', ['malformed_request']);
      return;
    }
    const spec = options.tools.get(params.data.name);
    if (!spec) {
      refuse('invalid_input', 'unregistered', ['unknown_tool']);
      return;
    }

    // 3. Strict arguments, validated against the same schema the tool advertises.
    const args = params.data.arguments ?? {};
    const valid = spec.inputSchema.safeParse(args);
    if (!valid.success) {
      const issues = valid.error.issues.slice(0, MAX_DIAGNOSTIC_ISSUES);
      options.diagnostics?.({
        tool: spec.name,
        issues: issues.map((issue) => ({ path: safePath(issue.path), code: String(issue.code) })),
      });
      refuse('invalid_input', spec.name, ['schema_validation'], valid.error.issues.length);
      return;
    }

    // 4. Admitted. Reserve the slot until the SDK answers this id. A duplicate id is refused, so one slot cannot be shared.
    if (pending.has(id)) {
      refuse('invalid_input', spec.name, ['duplicate_request_id']);
      return;
    }
    const timer = setTimeout(() => {
      pending.get(id)?.release();
      pending.delete(id);
    }, PENDING_TIMEOUT_MS);
    timer.unref();
    pending.set(id, { release: decision.release, timer });
    sdkOnMessage?.(message, extra);
  };
}

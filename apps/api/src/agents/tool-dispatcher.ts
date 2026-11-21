import type { RequestContext, ToolCall, ToolGateway } from '../security/tool-policy-gateway.js';

/**
 * Executes a tool only through the policy gateway. Model output never reaches a handler without
 * an allow decision, and a handler's output is returned only after the gateway accepts its run id.
 */

export interface ToolHandler<Input, Output> {
  /** Validates untrusted arguments into a typed input. Throws on invalid input. */
  readonly validate: (args: Readonly<Record<string, unknown>>) => Input;
  /**
   * Performs the tool. It may be asynchronous (for example a tenant-scoped database read). It receives the verified context the
   * gateway authorised, so it can scope its work to that tenant. It must not accept identity or scopes from its input.
   */
  readonly run: (input: Input, context: RequestContext) => Output | Promise<Output>;
}

export type DispatchResult<Output = unknown> =
  | { readonly status: 'ok'; readonly output: Output; readonly runId: string }
  | { readonly status: 'denied'; readonly reasons: readonly string[] }
  | { readonly status: 'error'; readonly message: string };

export interface ToolDispatcher {
  dispatch(call: ToolCall, context: RequestContext): Promise<DispatchResult>;
}

export function createToolDispatcher(
  gateway: ToolGateway,
  handlers: ReadonlyMap<string, ToolHandler<unknown, unknown>>,
): ToolDispatcher {
  return {
    async dispatch(call, context) {
      const decision = await gateway.authorise(call, context);
      if (!decision.allowed || decision.runId === undefined) {
        return { status: 'denied', reasons: decision.reasons };
      }
      const handler = handlers.get(call.toolName);
      if (!handler) return { status: 'denied', reasons: ['unknown_tool'] };
      try {
        const output = await handler.run(handler.validate(call.arguments), context);
        const accepted = gateway.acceptResult(decision.runId, context.tenantId);
        if (!accepted.accepted) return { status: 'denied', reasons: [accepted.reason ?? 'result_unknown_run'] };
        return { status: 'ok', output, runId: decision.runId };
      } catch (error) {
        // Close the issued run so it cannot be used later, then return only a bounded message.
        gateway.acceptResult(decision.runId, context.tenantId);
        // Stack traces and internal details stay in server logs.
        const message = error instanceof Error ? error.message.slice(0, 200) : 'tool failed';
        return { status: 'error', message };
      }
    },
  };
}

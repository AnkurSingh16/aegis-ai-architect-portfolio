import { randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Pool } from 'pg';
import { AuthorizationError, type VerifiedPrincipal, type VerifyToken } from '../auth/token.js';
import { withAuthenticatedTransaction } from '../auth/transaction.js';
import { createToolDispatcher, type ToolHandler } from '../agents/tool-dispatcher.js';
import type { RateLimiter } from '../security/rate-limiter.js';
import { type ApprovalStore, ToolGateway, type AgentRegistration, type ToolDefinition, verifiedRequestContext } from '../security/tool-policy-gateway.js';
import { type McpAuditSink, sanitiseDetail, subjectRef } from './audit.js';
import { MCP_AGENT_ID, MCP_TOOL_SPECS, mcpHandlers, mcpToolDefinitions, type McpToolSpec } from './tools.js';

/**
 * The AEGIS MCP server. It serves one tenant, with one credential held by the server process from its own configuration.
 *
 * Every tool call does four things, in this order, and each one is a check the server does not delegate to the model:
 * 1. authenticate the credential again through the production verifier (signature, issuer, audience, expiry);
 * 2. confirm the authenticated subject is a member of the configured tenant, and holds the read scope (database check);
 * 3. build a verified gateway context from that principal and the configured tenant, never from tool arguments;
 * 4. dispatch through the gateway, which applies scopes, tenant rules, argument screening, approvals and rate limits.
 * Every call writes exactly one audit event, and nothing a model supplied is trusted for identity, tenant or permission.
 */

export interface AegisMcpServerOptions {
  readonly pool: Pool;
  /** The credential this server presents. Held by the server process from its own configuration. */
  readonly bearerToken: string;
  /** The tenant this server serves. Comes from server configuration, never from a tool argument. */
  readonly tenantId: string;
  readonly verify: VerifyToken;
  readonly approvals: ApprovalStore;
  readonly limiter?: RateLimiter;
  readonly audit: McpAuditSink;
  readonly now?: () => Date;
  /** Test-only extension: extra gateway tools. Production passes none, so production exposes only the read-only tools above. */
  readonly extension?: {
    readonly specs: readonly McpToolSpec[];
    readonly definitions: readonly ToolDefinition[];
    readonly handlers: ReadonlyMap<string, ToolHandler<unknown, unknown>>;
    readonly agentScopes?: readonly string[];
  };
}

type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean; structuredContent?: Record<string, unknown> };

const text = (message: string, isError = false): ToolResult => (isError
  ? { content: [{ type: 'text', text: message }], isError: true }
  : { content: [{ type: 'text', text: message }] });

const AUTHENTICATION_REQUIRED = 'Authentication required.';
const ACCESS_DENIED = 'Access denied.';
const UNAVAILABLE = 'The request could not be completed. Please retry.';

export function createAegisMcpServer(options: AegisMcpServerOptions): McpServer {
  const now = options.now ?? (() => new Date());
  const extensionDefinitions = options.extension?.definitions ?? [];
  const gateway = new ToolGateway(
    new Map(mcpToolDefinitions(extensionDefinitions).map((d) => [d.name, d])),
    new Map<string, AgentRegistration>([[MCP_AGENT_ID, { agentId: MCP_AGENT_ID, active: true,
      scopes: ['read:cases', ...(options.extension?.agentScopes ?? [])] }]]),
    options.approvals,
    options.limiter,
  );
  const server = new McpServer({ name: 'aegis-mcp', version: '0.1.0' }, { capabilities: { tools: {} } });

  async function runTool(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    const started = performance.now();
    const requestRef = randomUUID();
    const audit = (outcome: 'allowed' | 'denied' | 'error' | 'unauthenticated' | 'not_a_member', tenantId: string | null,
      subject: string | null, reasons: readonly string[], detail?: Record<string, unknown>) => {
      options.audit.record({
        event: 'mcp.tool_call', at: now().toISOString(), requestRef, tool: name, tenantId, subjectRef: subject,
        outcome, reasons, durationMs: Math.round((performance.now() - started) * 1000) / 1000, detail: sanitiseDetail(detail),
      });
    };

    // 1. Authenticate the credential again. A failure carries no detail back to the model.
    let principal: VerifiedPrincipal;
    try {
      principal = await options.verify(`Bearer ${options.bearerToken}`);
    } catch {
      audit('unauthenticated', options.tenantId, null, ['authentication']);
      return text(AUTHENTICATION_REQUIRED, true);
    }
    const subject = subjectRef(principal.subject);

    // 2. Membership and the read scope, checked against the database for the configured tenant.
    try {
      await withAuthenticatedTransaction(options.pool, principal, options.tenantId, 'read:cases', async () => undefined);
    } catch (error) {
      if (error instanceof AuthorizationError) {
        audit('not_a_member', options.tenantId, subject, ['membership']);
        return text(ACCESS_DENIED, true);
      }
      audit('error', options.tenantId, subject, ['membership_check']);
      return text(UNAVAILABLE, true);
    }

    // 3 and 4. A context built from the verified principal and the configured tenant, then the gateway.
    const handlers = new Map<string, ToolHandler<unknown, unknown>>([
      ...mcpHandlers(options.pool, principal),
      ...(options.extension?.handlers ?? []),
    ]);
    const dispatcher = createToolDispatcher(gateway, handlers);
    const context = verifiedRequestContext(principal, { tenantId: options.tenantId, agentId: MCP_AGENT_ID, now: now() });
    // An approval reference is a model-supplied pointer to an approval a person already granted. The gateway validates it against
    // the trusted store (tenant-scoped, digest-bound, not self-approved, single use). Read-only schemas are strict, so only a tool
    // that declares approvalId can carry one. It is split out here so the digest covers the action arguments only.
    const { approvalId, ...toolArguments } = args;
    const result = await dispatcher.dispatch({
      toolName: name, arguments: toolArguments, approvalId: typeof approvalId === 'string' ? approvalId : undefined,
    }, context);

    if (result.status === 'ok') {
      const output = result.output as Record<string, unknown>;
      const resultCount = Array.isArray(output.results) ? output.results.length : undefined;
      const queryLength = typeof args.query === 'string' ? args.query.length : undefined;
      audit('allowed', options.tenantId, subject, [], { resultCount, queryLength });
      return { content: [{ type: 'text', text: JSON.stringify(output) }], structuredContent: output };
    }
    if (result.status === 'denied') {
      audit('denied', options.tenantId, subject, result.reasons);
      return text(`Denied: ${result.reasons.join(', ')}.`, true);
    }
    audit('error', options.tenantId, subject, ['tool_error']);
    return text(UNAVAILABLE, true);
  }

  const specs: readonly McpToolSpec[] = [...MCP_TOOL_SPECS, ...(options.extension?.specs ?? [])];
  for (const spec of specs) {
    // Built-in tools are read-only. An extension tool with a side effect is declared destructive so a client can show it.
    const sideEffectful = (options.extension?.definitions ?? []).some((d) => d.name === spec.name && d.sideEffect !== 'read');
    server.registerTool(spec.name, {
      title: spec.title,
      description: spec.description,
      inputSchema: spec.inputSchema,
      outputSchema: spec.outputSchema,
      annotations: { readOnlyHint: !sideEffectful, destructiveHint: sideEffectful, idempotentHint: false, openWorldHint: false },
    }, async (args: unknown) => runTool(spec.name, args as Record<string, unknown>));
  }
  return server;
}

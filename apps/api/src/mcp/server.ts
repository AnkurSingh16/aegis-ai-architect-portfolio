import { randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Pool } from 'pg';
import { AuthorizationError, type VerifiedPrincipal, type VerifyToken } from '../auth/token.js';
import { withAuthenticatedTransaction } from '../auth/transaction.js';
import { createToolDispatcher, type ToolHandler } from '../agents/tool-dispatcher.js';
import type { RateLimiter } from '../security/rate-limiter.js';
import { type ApprovalStore, ToolGateway, type AgentRegistration, type ToolDefinition, verifiedRequestContext } from '../security/tool-policy-gateway.js';
import { createAdmissionController, DEFAULT_ADMISSION, type AdmissionOptions } from './admission.js';
import { type McpAuditSink, sanitiseDetail, subjectRef } from './audit.js';
import { guardTransport, type ValidationDiagnostic } from './gate.js';
import { MCP_AGENT_ID, MCP_TOOL_SPECS, mcpHandlers, mcpToolDefinitions, type McpToolSpec } from './tools.js';

/**
 * The AEGIS MCP server.
 *
 * Production has one fixed registry: the read-only tools in tools.ts. There is no option to add tools to it. Test-only tools are
 * registered through `createRegisteredServer` with `allowSideEffects`, which refuses to run outside NODE_ENV=test (see
 * test-support.ts). Side-effecting definitions are refused in every other build.
 *
 * Every connection goes through `GuardedMcpServer.connect`, which installs the pre-dispatch gate (gate.ts). The gate admits or refuses
 * each `tools/call` before verification or database work, validates arguments with the advertised strict schema, and audits every
 * refusal. An admitted call then runs the steps below, in order:
 * 1. authenticate the credential again through the production verifier;
 * 2. confirm the authenticated subject is a member of the configured tenant and holds the read scope (database check);
 * 3. build a verified gateway context from that principal and the configured tenant, never from tool arguments;
 * 4. dispatch through the gateway, which applies scopes, tenant rules, argument screening, approvals and rate limits.
 * Every admitted call writes one audit event, and nothing a model supplied is trusted for identity, tenant or permission.
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
  /** Admission bounds for calls, applied before any verification or database work. */
  readonly admission?: AdmissionOptions;
  /** Development-only validation diagnostics (field paths and codes). Not wired in production unless the caller passes it. */
  readonly diagnostics?: (event: ValidationDiagnostic) => void;
}

/** The tools a server exposes. Built once per server, and fixed for its lifetime. */
export interface ToolRegistry {
  readonly specs: readonly McpToolSpec[];
  readonly definitions: readonly ToolDefinition[];
  readonly agentScopes: readonly string[];
  /** Handlers for one authenticated principal. The principal is fixed when the handlers are built. */
  handlersFor(pool: Pool, principal: VerifiedPrincipal): Map<string, ToolHandler<unknown, unknown>>;
}

export interface RegistryPolicy {
  /** True only for test support. Outside NODE_ENV=test this is refused. */
  readonly allowSideEffects: boolean;
}

export interface GuardedMcpServer {
  /** The only way to connect. Installs the pre-dispatch gate after the SDK has connected. */
  connect(transport: Parameters<McpServer['connect']>[0]): Promise<void>;
  close(): Promise<void>;
}

export const PRODUCTION_REGISTRY: ToolRegistry = {
  specs: MCP_TOOL_SPECS,
  definitions: mcpToolDefinitions(),
  agentScopes: [],
  handlersFor: (pool, principal) => mcpHandlers(pool, principal),
};

type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean; structuredContent?: Record<string, unknown> };

const text = (message: string, isError = false): ToolResult => (isError
  ? { content: [{ type: 'text', text: message }], isError: true }
  : { content: [{ type: 'text', text: message }] });

const AUTHENTICATION_REQUIRED = 'Authentication required.';
const ACCESS_DENIED = 'Access denied.';
const UNAVAILABLE = 'The request could not be completed. Please retry.';

/**
 * Builds a server for a registry. Production calls this with PRODUCTION_REGISTRY and `allowSideEffects: false`. Side-effecting
 * definitions are refused unless the policy allows them and the process is a test run.
 */
export function createRegisteredServer(options: AegisMcpServerOptions, registry: ToolRegistry, policy: RegistryPolicy): GuardedMcpServer {
  if (policy.allowSideEffects && process.env.NODE_ENV !== 'test') {
    throw new Error('Side-effecting MCP tools are available only in test runs.');
  }
  if (!policy.allowSideEffects) {
    for (const definition of registry.definitions) {
      if (definition.sideEffect !== 'read' || definition.requiresApproval) {
        throw new Error('The production MCP registry is read-only; side-effecting tools are refused.');
      }
    }
  }

  const now = options.now ?? (() => new Date());
  const sideEffectful = new Set(registry.definitions.filter((d) => d.sideEffect !== 'read').map((d) => d.name));
  const specByName = new Map(registry.specs.map((spec) => [spec.name, spec] as const));
  const gateway = new ToolGateway(
    new Map(registry.definitions.map((d) => [d.name, d])),
    new Map<string, AgentRegistration>([[MCP_AGENT_ID, { agentId: MCP_AGENT_ID, active: true,
      scopes: ['read:cases', ...registry.agentScopes] }]]),
    options.approvals,
    options.limiter,
  );
  const server = new McpServer({ name: 'aegis-mcp', version: '0.1.0' }, { capabilities: { tools: {} } });
  const admission = createAdmissionController(options.admission ?? DEFAULT_ADMISSION);

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
    const dispatcher = createToolDispatcher(gateway, registry.handlersFor(options.pool, principal));
    // An approval reference is a model-supplied pointer to an approval a person already granted. The gateway validates it against
    // the trusted store (tenant-scoped, digest-bound, not self-approved, single use). Read-only schemas are strict, so only a tool
    // that declares approvalId can carry one. It is split out so the digest covers the action arguments only.
    const { approvalId, ...toolArguments } = args;
    const context = verifiedRequestContext(principal, { tenantId: options.tenantId, agentId: MCP_AGENT_ID, now: now() });
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

  for (const spec of registry.specs) {
    // Built-in tools are read-only. A tool with a side effect is declared destructive so a client can show it.
    server.registerTool(spec.name, {
      title: spec.title,
      description: spec.description,
      inputSchema: spec.inputSchema,
      outputSchema: spec.outputSchema,
      annotations: { readOnlyHint: !sideEffectful.has(spec.name), destructiveHint: sideEffectful.has(spec.name),
        idempotentHint: false, openWorldHint: false },
    }, async (args: unknown) => runTool(spec.name, args as Record<string, unknown>));
  }

  return {
    async connect(transport) {
      await server.connect(transport);
      // The SDK has connected and started the transport. Install the gate now, so every later message passes through it.
      guardTransport(transport as unknown as Parameters<typeof guardTransport>[0], {
        tools: specByName,
        admission,
        audit: options.audit,
        tenantId: options.tenantId,
        now,
        diagnostics: options.diagnostics,
      });
    },
    async close() {
      await server.close();
    },
  };
}

/** The production server. It exposes only the read-only registry and takes no extension. */
export function createAegisMcpServer(options: AegisMcpServerOptions): GuardedMcpServer {
  return createRegisteredServer(options, PRODUCTION_REGISTRY, { allowSideEffects: false });
}

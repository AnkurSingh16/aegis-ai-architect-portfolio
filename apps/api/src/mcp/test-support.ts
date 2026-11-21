import type { Pool } from 'pg';
import type { VerifiedPrincipal } from '../auth/token.js';
import type { ToolHandler } from '../agents/tool-dispatcher.js';
import type { ToolDefinition } from '../security/tool-policy-gateway.js';
import { type AegisMcpServerOptions, createRegisteredServer, type GuardedMcpServer, type ToolRegistry } from './server.js';
import { mcpHandlers, mcpToolDefinitions, MCP_TOOL_SPECS, type McpToolSpec } from './tools.js';

/**
 * Test-only support. It adds tools to the registry, including a synthetic side-effecting tool, so the approval boundary can be tested
 * through a real client. Production code must not import this module. It is a separate module, and `createRegisteredServer` refuses
 * `allowSideEffects` outside NODE_ENV=test, so importing it in production still cannot register a side effect.
 */
export interface TestToolExtension {
  readonly specs: readonly McpToolSpec[];
  readonly definitions: readonly ToolDefinition[];
  readonly handlers: ReadonlyMap<string, ToolHandler<unknown, unknown>>;
  readonly agentScopes?: readonly string[];
}

export function createTestAegisMcpServer(options: AegisMcpServerOptions, extension: TestToolExtension): GuardedMcpServer {
  const registry: ToolRegistry = {
    specs: [...MCP_TOOL_SPECS, ...extension.specs],
    definitions: mcpToolDefinitions(extension.definitions),
    agentScopes: extension.agentScopes ?? [],
    handlersFor: (pool: Pool, principal: VerifiedPrincipal) => new Map<string, ToolHandler<unknown, unknown>>([
      ...mcpHandlers(pool, principal),
      ...extension.handlers,
    ]),
  };
  return createRegisteredServer(options, registry, { allowSideEffects: true });
}

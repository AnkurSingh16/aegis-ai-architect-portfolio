import type { Pool } from 'pg';
import { z } from 'zod';
import { withAuthenticatedTransaction } from '../auth/transaction.js';
import type { VerifiedPrincipal } from '../auth/token.js';
import type { ToolHandler } from '../agents/tool-dispatcher.js';
import { syntheticCases, categories, priorities, suggestedTeams, TRIAGE_WARNING, type SyntheticCaseId } from '../contracts/triage.js';
import { retrieveDocumentChunks, retrievalLimits } from '../documents/retrieval.js';
import type { ToolDefinition } from '../security/tool-policy-gateway.js';
import { triageCase } from '../triage.js';

/**
 * The read-only AEGIS capabilities exposed through MCP. Each one is a registered gateway tool with its own required scope. The
 * MCP layer adds no permission of its own: it authenticates, checks tenant membership, and then asks the gateway.
 *
 * Input schemas are strict: an unknown key (for example a tenant or a scope supplied by the model) is rejected, not ignored.
 */
export const MCP_AGENT_ID = 'mcp-agent' as const;
const CASE_IDS = syntheticCases.map((c) => c.id) as [SyntheticCaseId, ...SyntheticCaseId[]];

export const caseTriageInput = z.object({ caseId: z.enum(CASE_IDS) }).strict();
export const caseTriageOutput = z.object({
  mode: z.literal('synthetic-mock'),
  caseId: z.enum(CASE_IDS),
  category: z.enum(categories),
  priority: z.enum(priorities),
  suggestedTeam: z.enum(suggestedTeams),
  rationale: z.string(),
  nextStep: z.string(),
  warning: z.literal(TRIAGE_WARNING),
}).strict();

export const documentsSearchInput = z.object({
  query: z.string().min(1).max(retrievalLimits.maxQueryCharacters),
}).strict();
export const documentsSearchOutput = z.object({
  results: z.array(z.object({
    sourceIdentity: z.string(),
    title: z.string(),
    position: z.number().int().nonnegative(),
    rank: z.number(),
    content: z.string(),
  }).strict()).max(retrievalLimits.maxTopK),
}).strict();

export interface McpToolSpec {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly inputSchema: z.ZodTypeAny;
  readonly outputSchema: z.ZodTypeAny;
  readonly requiredScopes: readonly string[];
}

/** The tools this server offers. Read-only only. Adding a tool here is a security review, not a convenience change. */
export const MCP_TOOL_SPECS: readonly McpToolSpec[] = [
  {
    name: 'case.triage', title: 'Triage a synthetic case',
    description: 'Returns a synthetic triage recommendation for one of the demonstration cases. Read-only. Synthetic data only.',
    inputSchema: caseTriageInput, outputSchema: caseTriageOutput, requiredScopes: ['read:cases'],
  },
  {
    name: 'documents.search', title: 'Search synthetic support documents',
    description: 'Lexical search over the tenant\'s synthetic support documents. Returns up to five passages. Read-only.',
    inputSchema: documentsSearchInput, outputSchema: documentsSearchOutput, requiredScopes: ['read:cases'],
  },
];

/** Gateway definitions for the MCP tools, plus any test-only definitions the caller supplies. */
export function mcpToolDefinitions(extra: readonly ToolDefinition[] = []): ToolDefinition[] {
  return [
    { name: 'case.triage', requiredScopes: ['read:cases'], sideEffect: 'read', requiresApproval: false },
    { name: 'documents.search', requiredScopes: ['read:cases'], sideEffect: 'read', requiresApproval: false },
    ...extra,
  ];
}

export interface DocumentSearchOutput {
  readonly results: readonly { sourceIdentity: string; title: string; position: number; rank: number; content: string }[];
}

/**
 * Handlers for one authenticated principal. The principal is fixed when the handlers are built, and the tenant comes from the
 * verified context the gateway authorised. Neither can be changed by a tool argument.
 */
export function mcpHandlers(pool: Pool, principal: VerifiedPrincipal): Map<string, ToolHandler<unknown, unknown>> {
  const caseTriage: ToolHandler<{ caseId: SyntheticCaseId }, unknown> = {
    validate: (args) => caseTriageInput.parse(args),
    run: ({ caseId }) => caseTriageOutput.parse(triageCase(caseId)),
  };
  const documentsSearch: ToolHandler<{ query: string }, DocumentSearchOutput> = {
    validate: (args) => documentsSearchInput.parse(args),
    run: async ({ query }, context) => {
      const rows = await withAuthenticatedTransaction(pool, principal, context.tenantId, 'read:cases',
        (client) => retrieveDocumentChunks(client, context.tenantId, query));
      return documentsSearchOutput.parse({
        results: rows.map((row) => ({ sourceIdentity: row.sourceIdentity, title: row.title, position: row.position, rank: row.rank, content: row.content })),
      }) as DocumentSearchOutput;
    },
  };
  return new Map<string, ToolHandler<unknown, unknown>>([
    ['case.triage', caseTriage as ToolHandler<unknown, unknown>],
    ['documents.search', documentsSearch as ToolHandler<unknown, unknown>],
  ]);
}

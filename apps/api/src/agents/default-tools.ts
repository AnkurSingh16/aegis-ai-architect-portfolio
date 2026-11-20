import { syntheticCases, type SyntheticCaseId } from '../contracts/triage.js';
import { triageCase } from '../triage.js';
import type { AgentRegistration, ApprovalStore, ToolDefinition } from '../security/tool-policy-gateway.js';
import { ToolGateway } from '../security/tool-policy-gateway.js';
import { createToolDispatcher, type ToolDispatcher, type ToolHandler } from './tool-dispatcher.js';

/**
 * Registered tools for agents. Only read-only, deterministic tools are registered.
 * Side-effecting tools need an approval store, which is not persisted yet, so none are registered here.
 */
export const defaultToolDefinitions: readonly ToolDefinition[] = [
  { name: 'case.triage', requiredScopes: ['cases:read'], sideEffect: 'read', requiresApproval: false },
];

export const defaultAgents: readonly AgentRegistration[] = [
  { agentId: 'triage-agent', active: true, scopes: ['cases:read'] },
];

const knownCaseIds = new Set<string>(syntheticCases.map((c) => c.id));

const triageHandler: ToolHandler<SyntheticCaseId, ReturnType<typeof triageCase>> = {
  validate(args) {
    const caseId = args.caseId;
    if (typeof caseId !== 'string' || !knownCaseIds.has(caseId)) throw new Error('caseId must be a known synthetic case');
    return caseId as SyntheticCaseId;
  },
  run: (caseId) => triageCase(caseId),
};

/** Builds a dispatcher with the default tools. An approval store is required even though no tool uses it yet. */
export function createDefaultToolDispatcher(approvals: ApprovalStore): ToolDispatcher {
  const gateway = new ToolGateway(
    new Map(defaultToolDefinitions.map((t) => [t.name, t])),
    new Map(defaultAgents.map((a) => [a.agentId, a])),
    approvals,
  );
  const handlers = new Map<string, ToolHandler<unknown, unknown>>([
    ['case.triage', triageHandler as ToolHandler<unknown, unknown>],
  ]);
  return createToolDispatcher(gateway, handlers);
}

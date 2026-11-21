import { describe, expect, it, vi } from 'vitest';
import { createTestAuthentication } from '../auth/test-authentication.js';
import { createToolDispatcher, type ToolHandler } from '../agents/tool-dispatcher.js';
import { type AgentRegistration, type ApprovalStore, type ToolDefinition, ToolGateway, verifiedRequestContext } from './tool-policy-gateway.js';

const auth = await createTestAuthentication();
const agents: AgentRegistration[] = [{ agentId: 'agent-1', active: true, scopes: ['read:cases', 'write:cases'] }];
const noApprovals: ApprovalStore = { get: async () => undefined, consume: async () => false };
const NOW = new Date('2026-11-20T09:00:00.000Z');
const context = async () => verifiedRequestContext(await auth.principal('user-1', ['read:cases', 'write:cases']),
  { tenantId: 'tenant-a', agentId: 'agent-1', now: NOW });
const gatewayFor = (tools: ToolDefinition[]) => new ToolGateway(new Map(tools.map((t) => [t.name, t])), new Map(agents.map((a) => [a.agentId, a])), noApprovals);

describe('unsafe tool registrations fail closed at construction', () => {
  it.each([
    ['write without approval', { name: 'w', requiredScopes: ['write:cases'], sideEffect: 'write' as const, requiresApproval: false }],
    ['external without approval', { name: 'e', requiredScopes: ['write:cases'], sideEffect: 'external' as const, requiresApproval: false }],
  ])('refuses a %s registration', (_label, tool) => {
    expect(() => gatewayFor([tool])).toThrow(/must require approval/);
  });

  it('refuses an unknown side-effect value', () => {
    expect(() => gatewayFor([{ name: 'x', requiredScopes: [], sideEffect: 'delete' as never, requiresApproval: false }]))
      .toThrow(/unknown side effect/);
  });

  it('accepts a read tool without approval, and a write tool that requires approval', () => {
    expect(() => gatewayFor([
      { name: 'r', requiredScopes: ['read:cases'], sideEffect: 'read', requiresApproval: false },
      { name: 'w', requiredScopes: ['write:cases'], sideEffect: 'write', requiresApproval: true },
    ])).not.toThrow();
  });
});

describe('a side-effecting tool is never run without approval, even if its definition changes after registration', () => {
  it('denies a write tool whose requiresApproval was switched off after the gateway was built', async () => {
    const tool: ToolDefinition = { name: 'w', requiredScopes: ['write:cases'], sideEffect: 'write', requiresApproval: true };
    const gateway = gatewayFor([tool]);
    (tool as { requiresApproval: boolean }).requiresApproval = false;
    const decision = await gateway.authorise({ toolName: 'w', arguments: { note: 'x' } }, await context());
    expect(decision).toMatchObject({ allowed: false, reasons: ['approval_required'] });
    expect(decision.runId).toBeUndefined();
  });

  it('denies an external tool called with no approval identifier', async () => {
    const gateway = gatewayFor([{ name: 'ext', requiredScopes: ['write:cases'], sideEffect: 'external', requiresApproval: true }]);
    const decision = await gateway.authorise({ toolName: 'ext', arguments: {} }, await context());
    expect(decision.reasons).toEqual(['approval_required']);
  });

  it('never calls the handler when a side-effecting call is denied', async () => {
    const tool: ToolDefinition = { name: 'w', requiredScopes: ['write:cases'], sideEffect: 'write', requiresApproval: true };
    const run = vi.fn((input: { note: string }) => input.note);
    const handler: ToolHandler<{ note: string }, string> = { validate: (args) => ({ note: String(args.note) }), run };
    const dispatcher = createToolDispatcher(gatewayFor([tool]), new Map([['w', handler as ToolHandler<unknown, unknown>]]));
    const result = await dispatcher.dispatch({ toolName: 'w', arguments: { note: 'x' } }, await context());
    expect(result).toEqual({ status: 'denied', reasons: ['approval_required'] });
    expect(run).not.toHaveBeenCalled();
  });
});

import { describe, expect, it } from 'vitest';
import type { ApprovalStore, RequestContext, ToolCall } from '../security/tool-policy-gateway.js';
import { createDefaultToolDispatcher } from './default-tools.js';
import { createToolDispatcher, type ToolHandler } from './tool-dispatcher.js';
import { ToolGateway } from '../security/tool-policy-gateway.js';

const noApprovals: ApprovalStore = { get: async () => undefined, consume: async () => false };
const ctx = (overrides: Partial<RequestContext> = {}): RequestContext => ({
  tenantId: 'tenant-a', userId: 'user-1', userScopes: ['cases:read'], agentId: 'triage-agent',
  requestedBy: 'user-1', now: new Date('2026-11-19T10:00:00Z'), ...overrides,
});
const triage = (args: Record<string, unknown>): ToolCall => ({ toolName: 'case.triage', arguments: args });

describe('default tool dispatcher', () => {
  it('runs the triage tool through the gateway and returns the typed fixture output', async () => {
    const result = await createDefaultToolDispatcher(noApprovals).dispatch(triage({ caseId: 'SYNTHETIC-LOGIN-001' }), ctx());
    expect(result.status).toBe('ok');
    if (result.status === 'ok') {
      expect(result.output).toMatchObject({ caseId: 'SYNTHETIC-LOGIN-001', category: 'incident', priority: 'high' });
      expect(result.runId).toMatch(/^[0-9a-f-]{36}$/);
    }
  });

  it('denies when the user lacks the scope', async () => {
    const result = await createDefaultToolDispatcher(noApprovals).dispatch(triage({ caseId: 'SYNTHETIC-LOGIN-001' }), ctx({ userScopes: [] }));
    expect(result).toEqual({ status: 'denied', reasons: ['missing_scope'] });
  });

  it('denies tenant crossing through arguments', async () => {
    const result = await createDefaultToolDispatcher(noApprovals)
      .dispatch(triage({ caseId: 'SYNTHETIC-LOGIN-001', tenantId: 'tenant-b' }), ctx());
    expect(result).toEqual({ status: 'denied', reasons: ['tenant_in_arguments'] });
  });

  it('denies unknown tools and unknown agents', async () => {
    const dispatcher = createDefaultToolDispatcher(noApprovals);
    expect(await dispatcher.dispatch({ toolName: 'shell.exec', arguments: {} }, ctx()))
      .toMatchObject({ status: 'denied', reasons: ['unknown_tool'] });
    expect(await dispatcher.dispatch(triage({ caseId: 'SYNTHETIC-LOGIN-001' }), ctx({ agentId: 'ghost' })))
      .toMatchObject({ status: 'denied', reasons: ['unknown_agent'] });
  });

  it('returns a bounded error for invalid arguments that pass policy', async () => {
    const result = await createDefaultToolDispatcher(noApprovals).dispatch(triage({ caseId: 'NOT-A-CASE' }), ctx());
    expect(result).toEqual({ status: 'error', message: 'caseId must be a known synthetic case' });
  });

  it('exposes only the bounded message when a handler throws internal details', async () => {
    const gateway = new ToolGateway(
      new Map([['x.read', { name: 'x.read', requiredScopes: [], sideEffect: 'read' as const, requiresApproval: false }]]),
      new Map([['triage-agent', { agentId: 'triage-agent', active: true, scopes: [] }]]),
      noApprovals,
    );
    const failing: ToolHandler<unknown, unknown> = {
      validate: (args) => args,
      run: () => { throw new Error(`db password=hunter2 ${'x'.repeat(500)}`); },
    };
    const result = await createToolDispatcher(gateway, new Map([['x.read', failing]]))
      .dispatch({ toolName: 'x.read', arguments: {} }, ctx({ userScopes: [] }));
    expect(result.status).toBe('error');
    if (result.status === 'error') expect(result.message.length).toBeLessThanOrEqual(200);
  });
});

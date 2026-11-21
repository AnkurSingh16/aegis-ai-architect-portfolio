import { describe, expect, it } from 'vitest';
import { type AgentRegistration, type ApprovalStore, type RequestContext, type ToolCall, type ToolDefinition, ToolGateway, verifiedRequestContext } from './tool-policy-gateway.js';

const tools: ToolDefinition[] = [{ name: 'case.read', requiredScopes: ['read:cases'], sideEffect: 'read', requiresApproval: false }];
const agents: AgentRegistration[] = [{ agentId: 'triage-agent', active: true, scopes: ['read:cases'] }];
const approvals: ApprovalStore = { get: async () => undefined, consume: async () => false };
const call: ToolCall = { toolName: 'case.read', arguments: { caseId: 'SYNTHETIC-LOGIN-001' } };
const now = new Date('2026-11-20T09:00:00.000Z');
const gateway = () => new ToolGateway(new Map(tools.map((t) => [t.name, t])), new Map(agents.map((a) => [a.agentId, a])), approvals);

describe('identity boundary: the gateway accepts only verified contexts', () => {
  it('takes identity and scopes from the principal, not from the caller', () => {
    const context = verifiedRequestContext({ issuer: 'https://issuer.example.test/', subject: 'user-7', scopes: new Set(['read:cases']) },
      { tenantId: 'tenant-a', agentId: 'triage-agent', now });
    expect(context).toMatchObject({ tenantId: 'tenant-a', userId: 'user-7', requestedBy: 'user-7', userScopes: ['read:cases'] });
  });

  it('allows a verified context, and issues a run for it', async () => {
    const decision = await gateway().authorise(call, verifiedRequestContext(
      { issuer: 'https://issuer.example.test/', subject: 'user-7', scopes: new Set(['read:cases']) }, { tenantId: 'tenant-a', agentId: 'triage-agent', now }));
    expect(decision.allowed).toBe(true);
    expect(decision.runId).toBeDefined();
  });

  it('denies a context assembled by hand, even when it looks complete', async () => {
    const forged: RequestContext = { tenantId: 'tenant-a', userId: 'someone-else', userScopes: ['read:cases'], agentId: 'triage-agent', requestedBy: 'someone-else', now };
    const decision = await gateway().authorise(call, forged);
    expect(decision).toMatchObject({ allowed: false, reasons: ['unverified_context'] });
    expect(decision.runId).toBeUndefined();
  });

  it('denies a verified context that was copied with spread, so a copy cannot widen its scopes', async () => {
    const verified = verifiedRequestContext({ issuer: 'https://issuer.example.test/', subject: 'user-7', scopes: new Set() },
      { tenantId: 'tenant-a', agentId: 'triage-agent', now });
    const widened: RequestContext = { ...verified, userScopes: ['read:cases'] };
    const decision = await gateway().authorise(call, widened);
    expect(decision.reasons).toEqual(['unverified_context']);
    expect(decision.allowed).toBe(false);
  });
});

import { describe, expect, it } from 'vitest';
import { createTestAuthentication } from '../auth/test-authentication.js';
import { type AgentRegistration, type ApprovalStore, type RequestContext, type ToolCall, type ToolDefinition, ToolGateway, UnauthenticatedPrincipalError, verifiedRequestContext } from './tool-policy-gateway.js';

const tools: ToolDefinition[] = [{ name: 'case.read', requiredScopes: ['read:cases'], sideEffect: 'read', requiresApproval: false }];
const agents: AgentRegistration[] = [{ agentId: 'triage-agent', active: true, scopes: ['read:cases'] }];
const approvals: ApprovalStore = { get: async () => undefined, consume: async () => false };
const call: ToolCall = { toolName: 'case.read', arguments: { caseId: 'SYNTHETIC-LOGIN-001' } };
const now = new Date('2026-11-20T09:00:00.000Z');
const gateway = () => new ToolGateway(new Map(tools.map((t) => [t.name, t])), new Map(agents.map((a) => [a.agentId, a])), approvals);
const auth = await createTestAuthentication();

describe('identity boundary: the gateway accepts only contexts from authenticated principals', () => {
  it('takes identity and scopes from the verified token', async () => {
    const context = verifiedRequestContext(await auth.principal('user-7', ['read:cases']), { tenantId: 'tenant-a', agentId: 'triage-agent', now });
    expect(context).toMatchObject({ tenantId: 'tenant-a', userId: 'user-7', requestedBy: 'user-7', userScopes: ['read:cases'] });
  });

  it('allows a context built from a genuine principal, and issues a run for it', async () => {
    const decision = await gateway().authorise(call, verifiedRequestContext(await auth.principal('user-7', ['read:cases']),
      { tenantId: 'tenant-a', agentId: 'triage-agent', now }));
    expect(decision.allowed).toBe(true);
    expect(decision.runId).toBeDefined();
  });

  it('refuses a principal object built by hand, with any scopes it claims', () => {
    const fabricated = { issuer: 'https://issuer.example.test/', subject: 'admin', scopes: new Set(['read:cases', 'write:cases']) };
    expect(() => verifiedRequestContext(fabricated, { tenantId: 'tenant-a', agentId: 'triage-agent', now }))
      .toThrow(UnauthenticatedPrincipalError);
  });

  it('refuses a copy of a genuine principal that widens its scopes', async () => {
    const genuine = await auth.principal('user-7', ['read:cases']);
    const widened = { ...genuine, scopes: new Set(['read:cases', 'write:cases']) };
    expect(() => verifiedRequestContext(widened, { tenantId: 'tenant-a', agentId: 'triage-agent', now })).toThrow(UnauthenticatedPrincipalError);
  });

  it('denies a context assembled by hand, even when it looks complete', async () => {
    const forged: RequestContext = { tenantId: 'tenant-a', userId: 'someone-else', userScopes: ['read:cases'], agentId: 'triage-agent', requestedBy: 'someone-else', now };
    const decision = await gateway().authorise(call, forged);
    expect(decision).toMatchObject({ allowed: false, reasons: ['unverified_context'] });
    expect(decision.runId).toBeUndefined();
  });

  it('denies a genuine context that was copied with spread, so a copy cannot widen its scopes', async () => {
    const verified = verifiedRequestContext(await auth.principal('user-7', []), { tenantId: 'tenant-a', agentId: 'triage-agent', now });
    const widened: RequestContext = { ...verified, userScopes: ['read:cases'] };
    const decision = await gateway().authorise(call, widened);
    expect(decision.reasons).toEqual(['unverified_context']);
    expect(decision.allowed).toBe(false);
  });
});

import { createTestAuthentication } from '../auth/test-authentication.js';
import { describe, expect, it, vi } from 'vitest';
import { type AgentRegistration, type ApprovalStore, type RequestContext, type ToolCall, type ToolDefinition, ToolGateway, verifiedRequestContext } from './tool-policy-gateway.js';
import { createTokenBucketLimiter, inProcessRateLimiter } from './rate-limiter.js';

const tools: ToolDefinition[] = [{ name: 'case.triage', requiredScopes: ['read:cases'], sideEffect: 'read', requiresApproval: false }];
const agents: AgentRegistration[] = [{ agentId: 'triage-agent', active: true, scopes: ['read:cases'] }];
const approvals: ApprovalStore = { get: async () => undefined, consume: async () => false };
const call: ToolCall = { toolName: 'case.triage', arguments: { caseId: 'SYNTHETIC-BILLING-002' } };
const at = new Date('2026-11-20T09:00:00.000Z');
const auth = await createTestAuthentication();
const context = async (tenantId: string, agentId = 'triage-agent', scopes = ['read:cases']): Promise<RequestContext> =>
  verifiedRequestContext(await auth.principal('user-1', scopes), { tenantId, agentId, now: at });

describe('tool gateway with a rate limit', () => {
  it('allows calls within the limit and denies the next one with rate_limited and no run', async () => {
    const gateway = new ToolGateway(new Map(tools.map((t) => [t.name, t])), new Map(agents.map((a) => [a.agentId, a])), approvals,
      inProcessRateLimiter(createTokenBucketLimiter({ capacity: 1, refillPerSecond: 0.001 })));
    const first = await gateway.authorise(call, await context('tenant-a'));
    expect(first.allowed).toBe(true);
    const second = await gateway.authorise(call, await context('tenant-a'));
    expect(second).toMatchObject({ allowed: false, reasons: ['rate_limited'], effectiveScopes: [] });
    expect(second.runId).toBeUndefined();
    expect(second.audit).toMatchObject({ outcome: 'deny', reasons: ['rate_limited'], tenantId: 'tenant-a' });
  });

  it('limits each tenant and agent separately', async () => {
    const gateway = new ToolGateway(new Map(tools.map((t) => [t.name, t])), new Map(agents.map((a) => [a.agentId, a])), approvals,
      inProcessRateLimiter(createTokenBucketLimiter({ capacity: 1, refillPerSecond: 0.001 })));
    expect((await gateway.authorise(call, await context('tenant-a'))).allowed).toBe(true);
    expect((await gateway.authorise(call, await context('tenant-b'))).allowed).toBe(true);
    expect((await gateway.authorise(call, await context('tenant-a'))).reasons).toEqual(['rate_limited']);
  });

  it('checks the limit before scope and tenant checks, so a limited call is never allowed through', async () => {
    const gateway = new ToolGateway(new Map(tools.map((t) => [t.name, t])), new Map(agents.map((a) => [a.agentId, a])), approvals,
      inProcessRateLimiter(createTokenBucketLimiter({ capacity: 1, refillPerSecond: 0.001 })));
    await gateway.authorise(call, await context('tenant-a'));
    const denied = await gateway.authorise(call, await context('tenant-a', 'triage-agent', []));
    expect(denied.reasons).toEqual(['rate_limited']);
  });

  it('behaves exactly as before when no limiter is configured', async () => {
    const gateway = new ToolGateway(new Map(tools.map((t) => [t.name, t])), new Map(agents.map((a) => [a.agentId, a])), approvals);
    for (let i = 0; i < 5; i += 1) expect((await gateway.authorise(call, await context('tenant-a'))).allowed).toBe(true);
  });

  it('never asks the limiter about an unknown agent, so unknown ids create no limiter state', async () => {
    const take = vi.fn(async () => true);
    const gateway = new ToolGateway(new Map(tools.map((t) => [t.name, t])), new Map(agents.map((a) => [a.agentId, a])), approvals, { take });
    const decision = await gateway.authorise(call, await context('tenant-a', 'nobody'));
    expect(decision.reasons).toEqual(['unknown_agent']);
    expect(take).not.toHaveBeenCalled();
  });

  it('fails closed when the limiter cannot decide', async () => {
    const gateway = new ToolGateway(new Map(tools.map((t) => [t.name, t])), new Map(agents.map((a) => [a.agentId, a])), approvals,
      { take: async () => { throw new Error('database unavailable'); } });
    const decision = await gateway.authorise(call, await context('tenant-a'));
    expect(decision).toMatchObject({ allowed: false, reasons: ['rate_limit_unavailable'] });
    expect(decision.runId).toBeUndefined();
  });
});

import { createTestAuthentication } from '../auth/test-authentication.js';
import { describe, expect, it } from 'vitest';
import { type AgentRegistration, type ApprovalRecord, type ApprovalStore, actionDigest, canonicalJson, type RequestContext, type ToolCall, type ToolDefinition, ToolGateway, verifiedRequestContext } from './tool-policy-gateway.js';

const NOW = new Date('2026-11-19T10:00:00Z');
const tools: ToolDefinition[] = [
  { name: 'case.read', requiredScopes: ['cases:read'], sideEffect: 'read', requiresApproval: false },
  { name: 'case.close', requiredScopes: ['cases:write'], sideEffect: 'write', requiresApproval: true },
];
const agents: AgentRegistration[] = [
  { agentId: 'triage-agent', active: true, scopes: ['cases:read', 'cases:write'] },
  { agentId: 'reader-agent', active: true, scopes: ['cases:read'] },
  { agentId: 'retired-agent', active: false, scopes: ['cases:read'] },
];

function makeStore(records: ApprovalRecord[] = []): ApprovalStore & { consumed: Set<string> } {
  const byId = new Map(records.map((r) => [r.approvalId, r]));
  const consumed = new Set<string>();
  return {
    consumed,
    get: async (id, tenantId) => {
      const record = byId.get(id);
      return record && record.tenantId === tenantId ? record : undefined;
    },
    consume: async (id) => {
      if (consumed.has(id)) return false;
      consumed.add(id);
      return true;
    },
  };
}

function gateway(store = makeStore()): ToolGateway {
  return new ToolGateway(new Map(tools.map((t) => [t.name, t])), new Map(agents.map((a) => [a.agentId, a])), store);
}

const auth = await createTestAuthentication();
const ctx = async (overrides: Partial<RequestContext> = {}): Promise<RequestContext> => verifiedRequestContext(
  await auth.principal(overrides.userId ?? 'user-1', overrides.userScopes ?? ['cases:read', 'cases:write']),
  { tenantId: overrides.tenantId ?? 'tenant-a', agentId: overrides.agentId ?? 'triage-agent', now: overrides.now ?? NOW },
);

const closeArgs = { caseId: 'CASE-1' };
const approval = (overrides: Partial<ApprovalRecord> = {}): ApprovalRecord => ({
  approvalId: 'apr-1', status: 'approved', approvedBy: 'reviewer-9', tenantId: 'tenant-a',
  expiresAt: new Date(NOW.getTime() + 60_000), actionDigest: actionDigest('tenant-a', 'case.close', closeArgs), ...overrides,
});

const authorise = (g: ToolGateway, call: ToolCall, context: RequestContext) => g.authorise(call, context);

describe('tool policy gateway: allowed paths', () => {
  it('allows a read-only tool within scope and issues a run id', async () => {
    const decision = await authorise(gateway(), { toolName: 'case.read', arguments: { caseId: 'CASE-1' } }, await ctx());
    expect(decision.allowed).toBe(true);
    expect(decision.runId).toBeTypeOf('string');
    expect(decision.audit).toMatchObject({ outcome: 'allow', toolName: 'case.read', tenantId: 'tenant-a' });
  });

  it('allows a side-effecting tool with a valid, bound, unconsumed approval', async () => {
    const store = makeStore([approval()]);
    const decision = await authorise(gateway(store), { toolName: 'case.close', arguments: closeArgs, approvalId: 'apr-1' }, await ctx());
    expect(decision.allowed).toBe(true);
    expect(store.consumed.has('apr-1')).toBe(true);
  });
});

describe('tool policy gateway: adversarial denials', () => {
  it('denies unknown agents, unknown tools and inactive agents by default', async () => {
    expect((await authorise(gateway(), { toolName: 'case.read', arguments: {} }, await ctx({ agentId: 'ghost' }))).reasons).toContain('unknown_agent');
    expect((await authorise(gateway(), { toolName: 'shell.exec', arguments: {} }, await ctx())).reasons).toContain('unknown_tool');
    expect((await authorise(gateway(), { toolName: 'case.read', arguments: {} }, await ctx({ agentId: 'retired-agent' }))).reasons).toContain('inactive_agent');
  });

  it('denies unauthorised tool execution when the user lacks the scope', async () => {
    const decision = await authorise(gateway(), { toolName: 'case.read', arguments: {} }, await ctx({ userScopes: [] }));
    expect(decision.allowed).toBe(false);
    expect(decision.reasons).toEqual(['missing_scope']);
  });

  it('applies least privilege: the agent grant is intersected with the user grant', async () => {
    const decision = await authorise(gateway(makeStore([approval()])),
      { toolName: 'case.close', arguments: closeArgs, approvalId: 'apr-1' }, await ctx({ agentId: 'reader-agent' }));
    expect(decision.reasons).toContain('missing_scope');
    expect(decision.effectiveScopes).toEqual(['cases:read']);
  });

  it('denies tenant crossing through tenant fields inside arguments', async () => {
    const decision = await authorise(gateway(), { toolName: 'case.read', arguments: { tenantId: 'tenant-b', caseId: 'C' } }, await ctx());
    expect(decision.allowed).toBe(false);
    expect(decision.reasons).toContain('tenant_in_arguments');
  });

  it('denies escalated permission requests embedded in arguments', async () => {
    const decision = await authorise(gateway(), { toolName: 'case.read', arguments: { role: 'admin', caseId: 'C' } }, await ctx());
    expect(decision.reasons).toContain('privilege_in_arguments');
  });

  it('denies secret extraction attempts through arguments, including nested fields', async () => {
    const decision = await authorise(gateway(),
      { toolName: 'case.read', arguments: { caseId: 'C', options: { api_key: 'sk-test' } } }, await ctx());
    expect(decision.reasons).toContain('secret_in_arguments');
  });

  it('ignores approval text that model-produced arguments try to inject', async () => {
    const decision = await authorise(gateway(makeStore([])),
      { toolName: 'case.close', arguments: { ...closeArgs, approved: true, approvedBy: 'reviewer-9' } }, await ctx());
    expect(decision.allowed).toBe(false);
    expect(decision.reasons).toEqual(expect.arrayContaining(['privilege_in_arguments', 'approval_required']));
  });

  it('requires an approval for side-effecting tools', async () => {
    expect((await authorise(gateway(), { toolName: 'case.close', arguments: closeArgs }, await ctx())).reasons).toEqual(['approval_required']);
  });

  it('rejects an approval bound to a different action digest', async () => {
    const store = makeStore([approval({ actionDigest: 'f'.repeat(64) })]);
    const decision = await authorise(gateway(store), { toolName: 'case.close', arguments: closeArgs, approvalId: 'apr-1' }, await ctx());
    expect(decision.reasons).toContain('approval_digest_mismatch');
  });

  it('rejects approvals that are pending, rejected, expired or self-approved', async () => {
    const cases: [Partial<ApprovalRecord>, string][] = [
      [{ status: 'pending' }, 'approval_not_approved'],
      [{ status: 'rejected' }, 'approval_not_approved'],
      [{ expiresAt: new Date(NOW.getTime() - 1) }, 'approval_expired'],
      [{ approvedBy: 'user-1' }, 'approval_self_approved'],
      [{ approvedBy: 'triage-agent' }, 'approval_self_approved'],
    ];
    for (const [override, reason] of cases) {
      const store = makeStore([approval(override)]);
      const decision = await authorise(gateway(store), { toolName: 'case.close', arguments: closeArgs, approvalId: 'apr-1' }, await ctx());
      expect(decision.allowed, JSON.stringify(override)).toBe(false);
      expect(decision.reasons, JSON.stringify(override)).toContain(reason);
    }
  });

  it('treats an approval from another tenant as not found', async () => {
    const store = makeStore([approval({ tenantId: 'tenant-b' })]);
    const decision = await authorise(gateway(store), { toolName: 'case.close', arguments: closeArgs, approvalId: 'apr-1' }, await ctx());
    expect(decision.reasons).toEqual(['approval_required']);
  });

  it('prevents approval reuse across two requests', async () => {
    const g = gateway(makeStore([approval()]));
    expect((await authorise(g, { toolName: 'case.close', arguments: closeArgs, approvalId: 'apr-1' }, await ctx())).allowed).toBe(true);
    const second = await authorise(g, { toolName: 'case.close', arguments: closeArgs, approvalId: 'apr-1' }, await ctx());
    expect(second.allowed).toBe(false);
    expect(second.reasons).toContain('approval_consumed');
  });

  it('fails closed when an approval cannot be consumed', async () => {
    const store = makeStore([approval()]);
    await store.consume('apr-1', 'tenant-a', NOW); // pre-consumed by someone else
    const decision = await authorise(gateway(store), { toolName: 'case.close', arguments: closeArgs, approvalId: 'apr-1' }, await ctx());
    expect(decision.allowed).toBe(false);
    expect(decision.runId).toBeUndefined();
  });
});

describe('tool policy gateway: result verification', () => {
  it('accepts a result once for the issued run and tenant', async () => {
    const g = gateway();
    const { runId } = await authorise(g, { toolName: 'case.read', arguments: {} }, await ctx());
    expect(g.acceptResult(runId!, 'tenant-a')).toEqual({ accepted: true });
    expect(g.acceptResult(runId!, 'tenant-a').reason).toBe('result_replayed');
  });

  it('rejects forged results for run ids this gateway never issued', () => {
    expect(gateway().acceptResult('00000000-0000-4000-8000-000000000000', 'tenant-a').reason).toBe('result_unknown_run');
  });

  it('rejects results presented under another tenant', async () => {
    const g = gateway();
    const { runId } = await authorise(g, { toolName: 'case.read', arguments: {} }, await ctx());
    expect(g.acceptResult(runId!, 'tenant-b').reason).toBe('tenant_mismatch');
  });
});

describe('canonical digests', () => {
  it('is independent of key order and sensitive to tenant and tool', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe(canonicalJson({ a: { c: 3, d: 2 }, b: 1 }));
    expect(actionDigest('tenant-a', 'case.close', { x: 1 })).not.toBe(actionDigest('tenant-b', 'case.close', { x: 1 }));
    expect(actionDigest('tenant-a', 'case.close', { x: 1 })).not.toBe(actionDigest('tenant-a', 'case.read', { x: 1 }));
  });
});

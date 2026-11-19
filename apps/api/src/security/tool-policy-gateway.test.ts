import { describe, expect, it } from 'vitest';
import {
  type ApprovalRecord, type ApprovalStore, actionDigest, type AgentRegistration, canonicalJson,
  type RequestContext, type ToolDefinition, ToolGateway,
} from './tool-policy-gateway.js';

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
    get: (id) => byId.get(id),
    consume: (id) => { if (consumed.has(id)) return false; consumed.add(id); return true; },
  };
}

function gateway(store = makeStore()): ToolGateway {
  return new ToolGateway(new Map(tools.map((t) => [t.name, t])), new Map(agents.map((a) => [a.agentId, a])), store);
}

const ctx = (overrides: Partial<RequestContext> = {}): RequestContext => ({
  tenantId: 'tenant-a', userId: 'user-1', userScopes: ['cases:read', 'cases:write'],
  agentId: 'triage-agent', requestedBy: 'user-1', now: NOW, ...overrides,
});

const closeArgs = { caseId: 'CASE-1' };
const approval = (overrides: Partial<ApprovalRecord> = {}): ApprovalRecord => ({
  approvalId: 'apr-1', status: 'approved', approvedBy: 'reviewer-9', tenantId: 'tenant-a',
  expiresAt: new Date(NOW.getTime() + 60_000), actionDigest: actionDigest('tenant-a', 'case.close', closeArgs), ...overrides,
});

describe('tool policy gateway: allowed paths', () => {
  it('allows a read-only tool within scope and issues a run id', () => {
    const decision = gateway().authorise({ toolName: 'case.read', arguments: { caseId: 'CASE-1' } }, ctx());
    expect(decision.allowed).toBe(true);
    expect(decision.runId).toBeTypeOf('string');
    expect(decision.audit).toMatchObject({ outcome: 'allow', toolName: 'case.read', tenantId: 'tenant-a' });
  });

  it('allows a side-effecting tool with a valid, bound, unconsumed approval', () => {
    const store = makeStore([approval()]);
    const decision = gateway(store).authorise({ toolName: 'case.close', arguments: closeArgs, approvalId: 'apr-1' }, ctx());
    expect(decision.allowed).toBe(true);
    expect(store.consumed.has('apr-1')).toBe(true);
  });
});

describe('tool policy gateway: adversarial denials', () => {
  it('denies unknown agents, unknown tools and inactive agents by default', () => {
    expect(gateway().authorise({ toolName: 'case.read', arguments: {} }, ctx({ agentId: 'ghost' })).reasons).toContain('unknown_agent');
    expect(gateway().authorise({ toolName: 'shell.exec', arguments: {} }, ctx()).reasons).toContain('unknown_tool');
    expect(gateway().authorise({ toolName: 'case.read', arguments: {} }, ctx({ agentId: 'retired-agent' })).reasons).toContain('inactive_agent');
  });

  it('denies unauthorised tool execution when the user lacks the scope', () => {
    const decision = gateway().authorise({ toolName: 'case.read', arguments: {} }, ctx({ userScopes: [] }));
    expect(decision.allowed).toBe(false);
    expect(decision.reasons).toEqual(['missing_scope']);
  });

  it('applies least privilege: the agent grant is intersected with the user grant', () => {
    // reader-agent has only cases:read, so a write tool is refused even though the user may write.
    const decision = gateway(makeStore([approval()])).authorise(
      { toolName: 'case.close', arguments: closeArgs, approvalId: 'apr-1' },
      ctx({ agentId: 'reader-agent' }),
    );
    expect(decision.reasons).toContain('missing_scope');
    expect(decision.effectiveScopes).toEqual(['cases:read']);
  });

  it('denies tenant crossing through tenant fields inside arguments', () => {
    const decision = gateway().authorise({ toolName: 'case.read', arguments: { tenantId: 'tenant-b', caseId: 'C' } }, ctx());
    expect(decision.allowed).toBe(false);
    expect(decision.reasons).toContain('tenant_in_arguments');
  });

  it('denies escalated permission requests embedded in arguments', () => {
    const decision = gateway().authorise({ toolName: 'case.read', arguments: { role: 'admin', caseId: 'C' } }, ctx());
    expect(decision.reasons).toContain('privilege_in_arguments');
  });

  it('denies secret extraction attempts through arguments, including nested fields', () => {
    const decision = gateway().authorise(
      { toolName: 'case.read', arguments: { caseId: 'C', options: { api_key: 'sk-test' } } }, ctx(),
    );
    expect(decision.reasons).toContain('secret_in_arguments');
  });

  it('ignores approval text that model-produced arguments try to inject', () => {
    const decision = gateway(makeStore([])).authorise(
      { toolName: 'case.close', arguments: { ...closeArgs, approved: true, approvedBy: 'reviewer-9' } }, ctx(),
    );
    expect(decision.allowed).toBe(false);
    expect(decision.reasons).toEqual(expect.arrayContaining(['privilege_in_arguments', 'approval_required']));
  });

  it('requires an approval for side-effecting tools', () => {
    expect(gateway().authorise({ toolName: 'case.close', arguments: closeArgs }, ctx()).reasons).toEqual(['approval_required']);
  });

  it('rejects an approval bound to a different action digest', () => {
    const store = makeStore([approval({ actionDigest: 'f'.repeat(64) })]);
    const decision = gateway(store).authorise({ toolName: 'case.close', arguments: closeArgs, approvalId: 'apr-1' }, ctx());
    expect(decision.reasons).toContain('approval_digest_mismatch');
  });

  it('rejects approvals that are pending, rejected, expired or self-approved', () => {
    const cases: [Partial<ApprovalRecord>, string][] = [
      [{ status: 'pending' }, 'approval_not_approved'],
      [{ status: 'rejected' }, 'approval_not_approved'],
      [{ expiresAt: new Date(NOW.getTime() - 1) }, 'approval_expired'],
      [{ approvedBy: 'user-1' }, 'approval_self_approved'],
      [{ approvedBy: 'triage-agent' }, 'approval_self_approved'],
      [{ tenantId: 'tenant-b' }, 'tenant_mismatch'],
    ];
    for (const [override, reason] of cases) {
      const store = makeStore([approval(override)]);
      const decision = gateway(store).authorise({ toolName: 'case.close', arguments: closeArgs, approvalId: 'apr-1' }, ctx());
      expect(decision.allowed, JSON.stringify(override)).toBe(false);
      expect(decision.reasons, JSON.stringify(override)).toContain(reason);
    }
  });

  it('prevents approval reuse across two requests', () => {
    const g = gateway(makeStore([approval()]));
    expect(g.authorise({ toolName: 'case.close', arguments: closeArgs, approvalId: 'apr-1' }, ctx()).allowed).toBe(true);
    const second = g.authorise({ toolName: 'case.close', arguments: closeArgs, approvalId: 'apr-1' }, ctx());
    expect(second.allowed).toBe(false);
    expect(second.reasons).toContain('approval_consumed');
  });

  it('fails closed when an approval cannot be consumed', () => {
    const store = makeStore([approval()]);
    store.consume('apr-1'); // pre-consumed by someone else
    const decision = gateway(store).authorise({ toolName: 'case.close', arguments: closeArgs, approvalId: 'apr-1' }, ctx());
    expect(decision.allowed).toBe(false);
    expect(decision.runId).toBeUndefined();
  });
});

describe('tool policy gateway: result verification', () => {
  it('accepts a result once for the issued run and tenant', () => {
    const g = gateway();
    const { runId } = g.authorise({ toolName: 'case.read', arguments: {} }, ctx());
    expect(g.acceptResult(runId!, 'tenant-a')).toEqual({ accepted: true });
    expect(g.acceptResult(runId!, 'tenant-a').reason).toBe('result_replayed');
  });

  it('rejects forged results for run ids this gateway never issued', () => {
    expect(gateway().acceptResult('00000000-0000-4000-8000-000000000000', 'tenant-a').reason).toBe('result_unknown_run');
  });

  it('rejects results presented under another tenant', () => {
    const g = gateway();
    const { runId } = g.authorise({ toolName: 'case.read', arguments: {} }, ctx());
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

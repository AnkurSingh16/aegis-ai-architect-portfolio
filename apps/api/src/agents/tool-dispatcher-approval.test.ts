import { describe, expect, it } from 'vitest';
import { actionDigest, type ApprovalRecord, type ApprovalStore, type RequestContext, ToolGateway } from '../security/tool-policy-gateway.js';
import { createToolDispatcher, type ToolHandler } from './tool-dispatcher.js';

/** Test-only side-effecting tool. It is NOT registered in production code. */
const NOW = new Date('2026-11-19T10:00:00Z');
const args = { caseId: 'CASE-9' };
const digest = actionDigest('tenant-a', 'case.close', args);

function store(records: ApprovalRecord[]): ApprovalStore & { writes: number } {
  const state = { writes: 0, byId: new Map(records.map((r) => [r.approvalId, { ...r }])) };
  return {
    get: async (id, tenantId) => { const r = state.byId.get(id); return r && r.tenantId === tenantId ? r : undefined; },
    consume: async (id) => {
      const r = state.byId.get(id);
      if (!r || r.status !== 'approved') return false;
      state.byId.set(id, { ...r, status: 'consumed' });
      state.writes += 1;
      return true;
    },
    get writes() { return state.writes; },
  } as ApprovalStore & { writes: number };
}

function dispatcherWith(approvals: ApprovalStore, sideEffects: { count: number }) {
  const gateway = new ToolGateway(
    new Map([['case.close', { name: 'case.close', requiredScopes: ['cases:write'], sideEffect: 'write' as const, requiresApproval: true }]]),
    new Map([['triage-agent', { agentId: 'triage-agent', active: true, scopes: ['cases:write'] }]]),
    approvals,
  );
  const handler: ToolHandler<unknown, unknown> = {
    validate: (a) => a,
    run: () => { sideEffects.count += 1; return { closed: true }; },
  };
  return createToolDispatcher(gateway, new Map([['case.close', handler]]));
}

const ctx: RequestContext = { tenantId: 'tenant-a', userId: 'user-1', userScopes: ['cases:write'], agentId: 'triage-agent', requestedBy: 'user-1', now: NOW };
const approved = (approvalId: string, overrides: Partial<ApprovalRecord> = {}): ApprovalRecord => ({
  approvalId, tenantId: 'tenant-a', actionDigest: digest, status: 'approved', approvedBy: 'reviewer-9',
  expiresAt: new Date(NOW.getTime() + 60_000), ...overrides,
});

describe('side-effecting tools behind approval (test-only registration)', () => {
  it('does not run the side effect without an approval', async () => {
    const effects = { count: 0 };
    const result = await dispatcherWith(store([]), effects).dispatch({ toolName: 'case.close', arguments: args }, ctx);
    expect(result).toEqual({ status: 'denied', reasons: ['approval_required'] });
    expect(effects.count).toBe(0);
  });

  it('runs the side effect exactly once with a valid approval, and not again on replay', async () => {
    const effects = { count: 0 };
    const approvals = store([approved('apr-1')]);
    const dispatcher = dispatcherWith(approvals, effects);
    expect((await dispatcher.dispatch({ toolName: 'case.close', arguments: args, approvalId: 'apr-1' }, ctx)).status).toBe('ok');
    const replay = await dispatcher.dispatch({ toolName: 'case.close', arguments: args, approvalId: 'apr-1' }, ctx);
    // The stored status is already 'consumed', so the state check refuses it before any consume is attempted.
    expect(replay).toEqual({ status: 'denied', reasons: ['approval_not_approved'] });
    expect(effects.count).toBe(1);
  });

  it('does not run the side effect when the arguments differ from the approved action', async () => {
    const effects = { count: 0 };
    const result = await dispatcherWith(store([approved('apr-1')]), effects)
      .dispatch({ toolName: 'case.close', arguments: { caseId: 'CASE-OTHER' }, approvalId: 'apr-1' }, ctx);
    expect(result).toMatchObject({ status: 'denied', reasons: ['approval_digest_mismatch'] });
    expect(effects.count).toBe(0);
  });
});

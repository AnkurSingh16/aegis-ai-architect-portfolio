import { createTestAuthentication } from '../../auth/test-authentication.js';
import { createToolDispatcher, type DispatchResult, type ToolHandler } from '../../agents/tool-dispatcher.js';
import { createTokenBucketLimiter, inProcessRateLimiter } from '../../security/rate-limiter.js';
import { actionDigest, type AgentRegistration, type ApprovalRecord, type ApprovalStore, type RequestContext, type ToolCall, type ToolDefinition, ToolGateway, verifiedRequestContext } from '../../security/tool-policy-gateway.js';
import type { RecordedRun, RunOutcome, TrajectoryStep } from './trajectory-evaluation.js';

/**
 * Deterministic scenario harness. It runs the REAL gateway and dispatcher over synthetic tools whose only side effect is an
 * in-memory sink owned by this run. The approval store is in memory and enforces the same rules as the production store
 * (tenant scoping, self-approval refusal, single use, expiry). No model, no network, no database.
 */

export const SYNTHETIC_TOOLS: readonly ToolDefinition[] = [
  { name: 'case.read', requiredScopes: ['read:cases'], sideEffect: 'read', requiresApproval: false },
  { name: 'synthetic.note.write', requiredScopes: ['write:cases'], sideEffect: 'write', requiresApproval: true },
  { name: 'synthetic.export.external', requiredScopes: ['write:cases'], sideEffect: 'external', requiresApproval: true },
];
const AGENT: AgentRegistration = { agentId: 'agent-1', active: true, scopes: ['read:cases', 'write:cases'] };
const auth = await createTestAuthentication();

export interface Harness {
  readonly sink: string[];
  readonly steps: TrajectoryStep[];
  issueApproval(args: Record<string, unknown>, tenantId: string, requester: string, tool?: string, expiresAt?: Date): string;
  approve(approvalId: string, approver: string, now?: Date): boolean;
  failNextWrite(): void;
  dispatch(call: ToolCall, options?: DispatchOptions): Promise<DispatchResult>;
}

export interface DispatchOptions {
  readonly tenantId?: string;
  readonly subject?: string;
  readonly scopes?: readonly string[];
  readonly now?: Date;
  /** Hand-built context that did not come from the authentication layer. */
  readonly forged?: boolean;
}

export const T0 = new Date('2026-11-21T09:00:00.000Z');

export function createHarness(options: { rateLimitCapacity?: number } = {}): Harness {
  const records = new Map<string, ApprovalRecord & { requester: string; toolName: string; args: Record<string, unknown> }>();
  const used = new Map<string, number>();
  let counter = 0;
  const approvals: ApprovalStore = {
    async get(approvalId, tenantId) {
      const record = records.get(approvalId);
      return record && record.tenantId === tenantId ? record : undefined;
    },
    async consume(approvalId, tenantId, now) {
      const record = records.get(approvalId);
      if (!record || record.tenantId !== tenantId || record.status !== 'approved' || now.getTime() >= record.expiresAt.getTime()) return false;
      records.set(approvalId, { ...record, status: 'consumed' });
      used.set(approvalId, (used.get(approvalId) ?? 0) + 1);
      return true;
    },
  };
  const sink: string[] = [];
  const steps: TrajectoryStep[] = [];
  let failNext = false;
  const handlers = new Map<string, ToolHandler<unknown, unknown>>([
    ['case.read', { validate: (args) => args, run: () => 'read' } as ToolHandler<unknown, unknown>],
    ['synthetic.note.write', {
      validate: (args) => { if (typeof args.note !== 'string') throw new Error('note required'); return args.note; },
      run: (note) => { if (failNext) { failNext = false; throw new Error('synthetic failure'); } sink.push(String(note)); return sink.length; },
    } as ToolHandler<unknown, unknown>],
    ['synthetic.export.external', { validate: (args) => args, run: () => { sink.push('external'); return 1; } } as ToolHandler<unknown, unknown>],
  ]);
  const limiter = options.rateLimitCapacity === undefined ? undefined
    : inProcessRateLimiter(createTokenBucketLimiter({ capacity: options.rateLimitCapacity, refillPerSecond: 0.000001 }));
  const gateway = new ToolGateway(new Map(SYNTHETIC_TOOLS.map((t) => [t.name, t])), new Map([[AGENT.agentId, AGENT]]), approvals, limiter);
  const dispatcher = createToolDispatcher(gateway, handlers);
  const tools = new Map(SYNTHETIC_TOOLS.map((t) => [t.name, t]));

  return {
    sink, steps,
    issueApproval(args, tenantId, requester, tool = 'synthetic.note.write', expiresAt = new Date(T0.getTime() + 60_000)) {
      counter += 1;
      const approvalId = `00000000-0000-4000-8000-${String(counter).padStart(12, '0')}`;
      records.set(approvalId, { approvalId, tenantId, actionDigest: actionDigest(tenantId, tool, args), status: 'pending',
        approvedBy: '', expiresAt, requester, toolName: tool, args });
      return approvalId;
    },
    approve(approvalId, approver, now = T0) {
      const record = records.get(approvalId);
      if (!record || record.status !== 'pending' || approver === record.requester || now.getTime() >= record.expiresAt.getTime()) return false;
      records.set(approvalId, { ...record, status: 'approved', approvedBy: approver });
      return true;
    },
    failNextWrite() { failNext = true; },
    async dispatch(call, options = {}) {
      const tenantId = options.tenantId ?? 'tenant-a';
      const now = options.now ?? T0;
      let context: RequestContext;
      if (options.forged) {
        context = { tenantId, userId: 'forged', userScopes: [...(options.scopes ?? ['write:cases'])], agentId: 'agent-1', requestedBy: 'forged', now };
      } else {
        const principal = await auth.principal(options.subject ?? 'requester-1', [...(options.scopes ?? ['read:cases', 'write:cases'])]);
        context = verifiedRequestContext(principal, { tenantId, agentId: 'agent-1', now });
      }
      const result = await dispatcher.dispatch(call, context);
      const tool = tools.get(call.toolName);
      const committed = result.status === 'ok' && tool !== undefined && tool.sideEffect !== 'read';
      const outcome: RunOutcome = result.status === 'ok' ? 'ok' : result.status === 'denied' ? 'denied' : 'error';
      const reasons = result.status === 'denied' ? [...result.reasons] : result.status === 'error' ? ['handler_failed'] : [];
      const approvalId = typeof call.approvalId === 'string' ? call.approvalId : undefined;
      steps.push({
        tool: call.toolName, tenantId, outcome, reasons, sideEffectCommitted: committed,
        ...(approvalId !== undefined ? { approvalId, approvalTenantId: records.get(approvalId)?.tenantId } : {}),
      });
      return result;
    },
  };
}

export interface Scenario {
  readonly id: string;
  readonly expectedFinal: RecordedRun['expectedFinal'];
  readonly expectedSideEffects: number;
  readonly harnessOptions?: { readonly rateLimitCapacity?: number };
  readonly run: (h: Harness) => Promise<void>;
}

const NOTE = { note: 'synthetic note' };

export const SCENARIOS: readonly Scenario[] = [
  { id: 'read_allowed', expectedFinal: 'ok', expectedSideEffects: 0,
    run: async (h) => { await h.dispatch({ toolName: 'case.read', arguments: { caseId: 'SYNTHETIC-1' } }); } },
  { id: 'write_without_approval', expectedFinal: 'denied_or_error', expectedSideEffects: 0,
    run: async (h) => { await h.dispatch({ toolName: 'synthetic.note.write', arguments: NOTE }); } },
  { id: 'write_pending_approval', expectedFinal: 'denied_or_error', expectedSideEffects: 0,
    run: async (h) => { const id = h.issueApproval(NOTE, 'tenant-a', 'requester-1'); await h.dispatch({ toolName: 'synthetic.note.write', arguments: NOTE, approvalId: id }); } },
  { id: 'write_self_approval_refused', expectedFinal: 'denied_or_error', expectedSideEffects: 0,
    run: async (h) => { const id = h.issueApproval(NOTE, 'tenant-a', 'requester-1'); h.approve(id, 'requester-1');
      await h.dispatch({ toolName: 'synthetic.note.write', arguments: NOTE, approvalId: id }); } },
  { id: 'write_approved_once', expectedFinal: 'ok', expectedSideEffects: 1,
    run: async (h) => { const id = h.issueApproval(NOTE, 'tenant-a', 'requester-1'); h.approve(id, 'reviewer-2');
      await h.dispatch({ toolName: 'synthetic.note.write', arguments: NOTE, approvalId: id }); } },
  { id: 'approval_replay_refused', expectedFinal: 'denied_or_error', expectedSideEffects: 1,
    run: async (h) => { const id = h.issueApproval(NOTE, 'tenant-a', 'requester-1'); h.approve(id, 'reviewer-2');
      await h.dispatch({ toolName: 'synthetic.note.write', arguments: NOTE, approvalId: id });
      await h.dispatch({ toolName: 'synthetic.note.write', arguments: NOTE, approvalId: id }); } },
  { id: 'approval_digest_mismatch', expectedFinal: 'denied_or_error', expectedSideEffects: 0,
    run: async (h) => { const id = h.issueApproval(NOTE, 'tenant-a', 'requester-1'); h.approve(id, 'reviewer-2');
      await h.dispatch({ toolName: 'synthetic.note.write', arguments: { note: 'other' }, approvalId: id }); } },
  { id: 'cross_tenant_approval_refused', expectedFinal: 'denied_or_error', expectedSideEffects: 0,
    run: async (h) => { const id = h.issueApproval(NOTE, 'tenant-a', 'requester-1'); h.approve(id, 'reviewer-2');
      await h.dispatch({ toolName: 'synthetic.note.write', arguments: NOTE, approvalId: id }, { tenantId: 'tenant-b' }); } },
  { id: 'expired_approval_refused', expectedFinal: 'denied_or_error', expectedSideEffects: 0,
    run: async (h) => { const id = h.issueApproval(NOTE, 'tenant-a', 'requester-1', undefined, new Date(T0.getTime() + 1000)); h.approve(id, 'reviewer-2');
      await h.dispatch({ toolName: 'synthetic.note.write', arguments: NOTE, approvalId: id }, { now: new Date(T0.getTime() + 5000) }); } },
  { id: 'failed_run_then_fresh_approval', expectedFinal: 'ok', expectedSideEffects: 1,
    run: async (h) => { const first = h.issueApproval(NOTE, 'tenant-a', 'requester-1'); h.approve(first, 'reviewer-2'); h.failNextWrite();
      await h.dispatch({ toolName: 'synthetic.note.write', arguments: NOTE, approvalId: first });
      await h.dispatch({ toolName: 'synthetic.note.write', arguments: NOTE, approvalId: first });
      const fresh = h.issueApproval(NOTE, 'tenant-a', 'requester-1'); h.approve(fresh, 'reviewer-2');
      await h.dispatch({ toolName: 'synthetic.note.write', arguments: NOTE, approvalId: fresh }); } },
  { id: 'external_without_approval', expectedFinal: 'denied_or_error', expectedSideEffects: 0,
    run: async (h) => { await h.dispatch({ toolName: 'synthetic.export.external', arguments: {} }); } },
  { id: 'unknown_tool', expectedFinal: 'denied_or_error', expectedSideEffects: 0,
    run: async (h) => { await h.dispatch({ toolName: 'synthetic.drop.everything', arguments: {} }); } },
  { id: 'missing_write_scope', expectedFinal: 'denied_or_error', expectedSideEffects: 0,
    run: async (h) => { const id = h.issueApproval(NOTE, 'tenant-a', 'requester-1'); h.approve(id, 'reviewer-2');
      await h.dispatch({ toolName: 'synthetic.note.write', arguments: NOTE, approvalId: id }, { scopes: ['read:cases'] }); } },
  { id: 'forged_context_refused', expectedFinal: 'denied_or_error', expectedSideEffects: 0,
    run: async (h) => { await h.dispatch({ toolName: 'case.read', arguments: {} }, { forged: true }); } },
  { id: 'rate_limited_second_read', expectedFinal: 'denied_or_error', expectedSideEffects: 0, harnessOptions: { rateLimitCapacity: 1 },
    run: async (h) => { await h.dispatch({ toolName: 'case.read', arguments: {} }); await h.dispatch({ toolName: 'case.read', arguments: {} }); } },
];

/** Runs one scenario on a fresh harness and returns its recorded run. */
export async function runScenario(scenario: Scenario): Promise<RecordedRun> {
  const harness = createHarness(scenario.harnessOptions);
  await scenario.run(harness);
  const finalOutcome: RunOutcome = harness.steps.length === 0 ? 'denied' : harness.steps[harness.steps.length - 1]!.outcome;
  return { scenario: scenario.id, expectedFinal: scenario.expectedFinal, finalOutcome, steps: [...harness.steps],
    tenantId: 'tenant-a', expectedSideEffects: scenario.expectedSideEffects };
}

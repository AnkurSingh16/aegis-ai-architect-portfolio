import { createTestAuthentication } from '../../auth/test-authentication.js';
import { createToolDispatcher, type DispatchResult, type ToolHandler } from '../../agents/tool-dispatcher.js';
import { createTokenBucketLimiter, inProcessRateLimiter } from '../../security/rate-limiter.js';
import { actionDigest, type AgentRegistration, type ApprovalRecord, type ApprovalStore, type RequestContext, type ToolCall, type ToolDefinition, type ToolGateway, ToolGateway as RealGateway, verifiedRequestContext } from '../../security/tool-policy-gateway.js';
import type { ObservedConsume, RecordedRunV2, RunOutcome, ScenarioClass, StepV2 } from './trajectory-evaluation-v2.js';

/**
 * Trajectory harness, v2. The evaluator observes two things directly, independent of what the dispatcher returns:
 * - the synthetic state (a list of notes, and a list of external sends), and
 * - every approval consumption the approval store performs, with the approval's own tenant, digest, requester and expiry.
 * Fault modes replace the gateway or the handler with a faulty implementation. They are CONTROL runs: each one must be
 * detected by the evaluator. No model, no network, no database.
 */

export const SYNTHETIC_TOOLS_V2: readonly ToolDefinition[] = [
  { name: 'case.read', requiredScopes: ['read:cases'], sideEffect: 'read', requiresApproval: false },
  { name: 'synthetic.note.write', requiredScopes: ['write:cases'], sideEffect: 'write', requiresApproval: true },
  { name: 'synthetic.export.external', requiredScopes: ['write:cases'], sideEffect: 'external', requiresApproval: true },
];
const AGENT: AgentRegistration = { agentId: 'agent-1', active: true, scopes: ['read:cases', 'write:cases'] };
const auth = await createTestAuthentication();
export const T0 = new Date('2026-11-21T09:00:00.000Z');

/** Faulty execution paths. Each is a plausible regression, injected deliberately to prove the evaluator sees it. */
export type FaultMode =
  | 'none'
  | 'skip_approval'            // gateway allows a write without any approval
  | 'consume_wrong_tenant'     // gateway consumes another tenant's approval
  | 'consume_wrong_digest'     // gateway consumes an approval for different arguments
  | 'consume_expired'          // gateway consumes an approval after its expiry
  | 'reuse_approval'           // approval store lets a consumed approval be consumed again
  | 'write_then_fail';         // handler changes state, then throws

interface ApprovalRow extends ApprovalRecord { requester: string; toolName: string }

export interface HarnessV2 {
  readonly state: { notes: string[]; externals: number };
  readonly consumeLog: ObservedConsume[];
  readonly steps: StepV2[];
  issueApproval(args: Record<string, unknown>, tenantId: string, requester: string, tool?: string, expiresAt?: Date): string;
  approve(approvalId: string, approver: string, now?: Date): boolean;
  /** The next write fails before it changes state. */
  failNextWrite(): void;
  dispatch(call: ToolCall, options?: DispatchOptionsV2): Promise<DispatchResult>;
}

export interface DispatchOptionsV2 {
  readonly tenantId?: string;
  readonly subject?: string;
  readonly scopes?: readonly string[];
  readonly now?: Date;
  readonly forged?: boolean;
}

export function createHarnessV2(options: { fault?: FaultMode; rateLimitCapacity?: number } = {}): HarnessV2 {
  const fault = options.fault ?? 'none';
  const rows = new Map<string, ApprovalRow>();
  const consumeLog: ObservedConsume[] = [];
  const state = { notes: [] as string[], externals: 0 };
  const steps: StepV2[] = [];
  let counter = 0;
  let failNext = false;

  /** Approval store. Its consume is the observed event: it records the approval's own facts, not the caller's. */
  const store = {
    async get(approvalId: string, tenantId: string) {
      const row = rows.get(approvalId);
      return row && row.tenantId === tenantId ? row : undefined;
    },
    async consume(approvalId: string, tenantId: string, now: Date) {
      const row = rows.get(approvalId);
      const expired = row !== undefined && now.getTime() >= row.expiresAt.getTime();
      const usable = row !== undefined && row.tenantId === tenantId && row.status === 'approved' && !expired;
      const reuse = fault === 'reuse_approval' && row !== undefined && row.status === 'consumed';
      const consumed = usable || reuse;
      if (row !== undefined) {
        consumeLog.push({ approvalId, tenantId: row.tenantId, actionDigest: row.actionDigest, subject: row.requester, expired, consumed });
        if (consumed) rows.set(approvalId, { ...row, status: 'consumed' });
      }
      return consumed;
    },
  };
  const realStore: ApprovalStore = store;

  const handlers = new Map<string, ToolHandler<unknown, unknown>>([
    ['case.read', { validate: (args) => args, run: () => 'read' } as ToolHandler<unknown, unknown>],
    ['synthetic.note.write', {
      validate: (args) => { if (typeof args.note !== 'string') throw new Error('note required'); return args.note; },
      run: (note) => {
        if (failNext) { failNext = false; throw new Error('synthetic transient failure before the change'); }
        state.notes.push(String(note));
        if (fault === 'write_then_fail') throw new Error('synthetic failure after the change');
        return state.notes.length;
      },
    } as ToolHandler<unknown, unknown>],
    ['synthetic.export.external', { validate: (args) => args, run: () => { state.externals += 1; return 1; } } as ToolHandler<unknown, unknown>],
  ]);

  const limiter = options.rateLimitCapacity === undefined ? undefined
    : inProcessRateLimiter(createTokenBucketLimiter({ capacity: options.rateLimitCapacity, refillPerSecond: 0.000001 }));
  const realGateway = new RealGateway(new Map(SYNTHETIC_TOOLS_V2.map((t) => [t.name, t])), new Map([[AGENT.agentId, AGENT]]), realStore, limiter);
  const gateway = fault === 'none' || fault === 'write_then_fail' ? realGateway
    : faultyGateway(fault, rows, consumeLog, state, realGateway);
  const dispatcher = createToolDispatcher(gateway as ToolGateway, handlers);
  const tools = new Map(SYNTHETIC_TOOLS_V2.map((t) => [t.name, t]));

  return {
    state, consumeLog, steps,
    failNextWrite() { failNext = true; },
    issueApproval(args, tenantId, requester, tool = 'synthetic.note.write', expiresAt = new Date(T0.getTime() + 60_000)) {
      counter += 1;
      const approvalId = `00000000-0000-4000-8000-${String(counter).padStart(12, '0')}`;
      rows.set(approvalId, { approvalId, tenantId, actionDigest: actionDigest(tenantId, tool, args), status: 'pending',
        approvedBy: '', expiresAt, requester, toolName: tool });
      return approvalId;
    },
    approve(approvalId, approver, now = T0) {
      const row = rows.get(approvalId);
      if (!row || row.status !== 'pending' || approver === row.requester || now.getTime() >= row.expiresAt.getTime()) return false;
      rows.set(approvalId, { ...row, status: 'approved', approvedBy: approver });
      return true;
    },
    async dispatch(call, opts = {}) {
      const tenantId = opts.tenantId ?? 'tenant-a';
      const subject = opts.subject ?? 'requester-1';
      const now = opts.now ?? T0;
      let context: RequestContext;
      if (opts.forged) {
        context = { tenantId, userId: subject, userScopes: [...(opts.scopes ?? ['write:cases'])], agentId: 'agent-1', requestedBy: subject, now };
      } else {
        const principal = await auth.principal(subject, [...(opts.scopes ?? ['read:cases', 'write:cases'])]);
        context = verifiedRequestContext(principal, { tenantId, agentId: 'agent-1', now });
      }
      const stateBefore = state.notes.length + state.externals;
      const consumesBefore = consumeLog.length;
      const result = await dispatcher.dispatch(call, context);
      const stateDelta = state.notes.length + state.externals - stateBefore;
      const tool = tools.get(call.toolName);
      const outcome: RunOutcome = result.status === 'ok' ? 'ok' : result.status === 'denied' ? 'denied' : 'error';
      const reasons = result.status === 'denied' ? [...result.reasons] : result.status === 'error' ? ['handler_failed'] : [];
      const presented = typeof call.approvalId === 'string' ? call.approvalId : undefined;
      const presentedRow = presented === undefined ? undefined : rows.get(presented);
      steps.push({
        tool: call.toolName, tenantId, outcome, reasons, subject,
        actionDigest: actionDigest(tenantId, call.toolName, call.arguments),
        observedStateDelta: stateDelta,
        consumes: consumeLog.slice(consumesBefore),
        ...(presented !== undefined ? { presentedApprovalId: presented } : {}),
        ...(presentedRow !== undefined ? { approvalExpiresAt: presentedRow.expiresAt.toISOString() } : {}),
      });
      void tool;
      return result;
    },
  };
}

/** A gateway with one injected regression. It decides and records the way the regression would, then the real handler runs. */
function faultyGateway(fault: FaultMode, rows: Map<string, ApprovalRow>, consumeLog: ObservedConsume[],
  state: { notes: string[]; externals: number }, real: ToolGateway) {
  return {
    async authorise(call: ToolCall, context: RequestContext) {
      if (fault === 'skip_approval' && call.toolName === 'synthetic.note.write') {
        return { allowed: true, reasons: [], actionDigest: '', effectiveScopes: [], runId: `bypass-${state.notes.length}`,
          audit: { tenantId: context.tenantId, userId: context.userId, agentId: context.agentId, toolName: call.toolName, actionDigest: '', outcome: 'allow' as const, reasons: [], at: context.now.toISOString() } };
      }
      const approvalId = typeof call.approvalId === 'string' ? call.approvalId : undefined;
      if (approvalId !== undefined && (fault === 'consume_wrong_tenant' || fault === 'consume_wrong_digest' || fault === 'consume_expired' || fault === 'reuse_approval')) {
        const row = rows.get(approvalId);
        if (row !== undefined) {
          const expired = context.now.getTime() >= row.expiresAt.getTime();
          // reuse_approval: the regression lets a consumed approval be consumed again.
          const consumable = row.status === 'approved' || (fault === 'reuse_approval' && row.status === 'consumed');
          if (consumable) rows.set(approvalId, { ...row, status: 'consumed' });
          consumeLog.push({ approvalId, tenantId: row.tenantId, actionDigest: row.actionDigest, subject: row.requester, expired, consumed: consumable });
          if (consumable) return { allowed: true, reasons: [], actionDigest: '', effectiveScopes: [], runId: `fault-${approvalId}`,
            audit: { tenantId: context.tenantId, userId: context.userId, agentId: context.agentId, toolName: call.toolName, actionDigest: '', outcome: 'allow' as const, reasons: [], at: context.now.toISOString() } };
        }
      }
      return real.authorise(call, context);
    },
    // The faulty path issues its own run ids, and the dispatcher must be able to close them as the real gateway would.
    acceptResult(runId: string, tenantId: string) {
      if (runId.startsWith('bypass-') || runId.startsWith('fault-')) return { accepted: true, reason: undefined };
      return real.acceptResult(runId, tenantId);
    },
  };
}

export interface ScenarioV2 {
  readonly id: string;
  readonly scenarioClass: ScenarioClass;
  readonly expectedFinal: RecordedRunV2['expectedFinal'];
  readonly expectedStateDelta: number;
  readonly fault?: FaultMode;
  /** For control runs: the violation the evaluator must report. */
  readonly controlFor?: string;
  readonly harnessOptions?: { readonly rateLimitCapacity?: number };
  readonly run: (h: HarnessV2) => Promise<void>;
}

const NOTE = { note: 'synthetic note' };

export const BASELINE_SCENARIOS_V2: readonly ScenarioV2[] = [
  { id: 'read_allowed', scenarioClass: 'read', expectedFinal: 'ok', expectedStateDelta: 0,
    run: async (h) => { await h.dispatch({ toolName: 'case.read', arguments: { caseId: 'SYNTHETIC-1' } }); } },
  { id: 'write_without_approval', scenarioClass: 'authorised_write', expectedFinal: 'denied_or_error', expectedStateDelta: 0,
    run: async (h) => { await h.dispatch({ toolName: 'synthetic.note.write', arguments: NOTE }); } },
  { id: 'write_pending_approval', scenarioClass: 'authorised_write', expectedFinal: 'denied_or_error', expectedStateDelta: 0,
    run: async (h) => { const id = h.issueApproval(NOTE, 'tenant-a', 'requester-1'); await h.dispatch({ toolName: 'synthetic.note.write', arguments: NOTE, approvalId: id }); } },
  { id: 'write_self_approval_refused', scenarioClass: 'authorised_write', expectedFinal: 'denied_or_error', expectedStateDelta: 0,
    run: async (h) => { const id = h.issueApproval(NOTE, 'tenant-a', 'requester-1'); h.approve(id, 'requester-1');
      await h.dispatch({ toolName: 'synthetic.note.write', arguments: NOTE, approvalId: id }); } },
  { id: 'write_approved_once', scenarioClass: 'authorised_write', expectedFinal: 'ok', expectedStateDelta: 1,
    run: async (h) => { const id = h.issueApproval(NOTE, 'tenant-a', 'requester-1'); h.approve(id, 'reviewer-2');
      await h.dispatch({ toolName: 'synthetic.note.write', arguments: NOTE, approvalId: id }); } },
  { id: 'approval_replay_refused', scenarioClass: 'replay', expectedFinal: 'denied_or_error', expectedStateDelta: 1,
    run: async (h) => { const id = h.issueApproval(NOTE, 'tenant-a', 'requester-1'); h.approve(id, 'reviewer-2');
      await h.dispatch({ toolName: 'synthetic.note.write', arguments: NOTE, approvalId: id });
      await h.dispatch({ toolName: 'synthetic.note.write', arguments: NOTE, approvalId: id }); } },
  { id: 'approval_digest_mismatch', scenarioClass: 'digest_binding', expectedFinal: 'denied_or_error', expectedStateDelta: 0,
    run: async (h) => { const id = h.issueApproval(NOTE, 'tenant-a', 'requester-1'); h.approve(id, 'reviewer-2');
      await h.dispatch({ toolName: 'synthetic.note.write', arguments: { note: 'other' }, approvalId: id }); } },
  { id: 'cross_tenant_approval_refused', scenarioClass: 'cross_tenant', expectedFinal: 'denied_or_error', expectedStateDelta: 0,
    run: async (h) => { const id = h.issueApproval(NOTE, 'tenant-a', 'requester-1'); h.approve(id, 'reviewer-2');
      await h.dispatch({ toolName: 'synthetic.note.write', arguments: NOTE, approvalId: id }, { tenantId: 'tenant-b' }); } },
  { id: 'expired_approval_refused', scenarioClass: 'expiry', expectedFinal: 'denied_or_error', expectedStateDelta: 0,
    run: async (h) => { const id = h.issueApproval(NOTE, 'tenant-a', 'requester-1', undefined, new Date(T0.getTime() + 1000)); h.approve(id, 'reviewer-2');
      await h.dispatch({ toolName: 'synthetic.note.write', arguments: NOTE, approvalId: id }, { now: new Date(T0.getTime() + 5000) }); } },
  { id: 'failed_run_then_fresh_approval', scenarioClass: 'failure', expectedFinal: 'ok', expectedStateDelta: 1,
    run: async (h) => { const first = h.issueApproval(NOTE, 'tenant-a', 'requester-1'); h.approve(first, 'reviewer-2'); h.failNextWrite();
      await h.dispatch({ toolName: 'synthetic.note.write', arguments: NOTE, approvalId: first });
      await h.dispatch({ toolName: 'synthetic.note.write', arguments: NOTE, approvalId: first });
      const fresh = h.issueApproval(NOTE, 'tenant-a', 'requester-1'); h.approve(fresh, 'reviewer-2');
      await h.dispatch({ toolName: 'synthetic.note.write', arguments: NOTE, approvalId: fresh }); } },
  { id: 'external_without_approval', scenarioClass: 'authorised_write', expectedFinal: 'denied_or_error', expectedStateDelta: 0,
    run: async (h) => { await h.dispatch({ toolName: 'synthetic.export.external', arguments: {} }); } },
  { id: 'unknown_tool', scenarioClass: 'unknown_tool', expectedFinal: 'denied_or_error', expectedStateDelta: 0,
    run: async (h) => { await h.dispatch({ toolName: 'synthetic.drop.everything', arguments: {} }); } },
  { id: 'missing_write_scope', scenarioClass: 'scope', expectedFinal: 'denied_or_error', expectedStateDelta: 0,
    run: async (h) => { const id = h.issueApproval(NOTE, 'tenant-a', 'requester-1'); h.approve(id, 'reviewer-2');
      await h.dispatch({ toolName: 'synthetic.note.write', arguments: NOTE, approvalId: id }, { scopes: ['read:cases'] }); } },
  { id: 'forged_context_refused', scenarioClass: 'forged_identity', expectedFinal: 'denied_or_error', expectedStateDelta: 0,
    run: async (h) => { await h.dispatch({ toolName: 'case.read', arguments: {} }, { forged: true }); } },
  { id: 'rate_limited_second_read', scenarioClass: 'rate_limit', expectedFinal: 'denied_or_error', expectedStateDelta: 0, harnessOptions: { rateLimitCapacity: 1 },
    run: async (h) => { await h.dispatch({ toolName: 'case.read', arguments: {} }); await h.dispatch({ toolName: 'case.read', arguments: {} }); } },
];

/** Control runs. Each injects one faulty execution path. The evaluator must detect the named violation for every one. */
export const CONTROL_SCENARIOS_V2: readonly ScenarioV2[] = [
  { id: 'control_gateway_skips_approval', scenarioClass: 'authorised_write', expectedFinal: 'ok', expectedStateDelta: 1,
    fault: 'skip_approval', controlFor: 'unauthorised_side_effect',
    run: async (h) => { await h.dispatch({ toolName: 'synthetic.note.write', arguments: NOTE }); } },
  { id: 'control_gateway_consumes_wrong_tenant', scenarioClass: 'cross_tenant', expectedFinal: 'ok', expectedStateDelta: 1,
    fault: 'consume_wrong_tenant', controlFor: 'wrong_tenant_consume',
    run: async (h) => { const id = h.issueApproval(NOTE, 'tenant-a', 'requester-1'); h.approve(id, 'reviewer-2');
      await h.dispatch({ toolName: 'synthetic.note.write', arguments: NOTE, approvalId: id }, { tenantId: 'tenant-b' }); } },
  { id: 'control_gateway_consumes_wrong_digest', scenarioClass: 'digest_binding', expectedFinal: 'ok', expectedStateDelta: 1,
    fault: 'consume_wrong_digest', controlFor: 'digest_mismatch_consume',
    run: async (h) => { const id = h.issueApproval(NOTE, 'tenant-a', 'requester-1'); h.approve(id, 'reviewer-2');
      await h.dispatch({ toolName: 'synthetic.note.write', arguments: { note: 'other' }, approvalId: id }); } },
  { id: 'control_gateway_consumes_expired', scenarioClass: 'expiry', expectedFinal: 'ok', expectedStateDelta: 1,
    fault: 'consume_expired', controlFor: 'expired_consume',
    run: async (h) => { const id = h.issueApproval(NOTE, 'tenant-a', 'requester-1', undefined, new Date(T0.getTime() + 1000)); h.approve(id, 'reviewer-2');
      await h.dispatch({ toolName: 'synthetic.note.write', arguments: NOTE, approvalId: id }, { now: new Date(T0.getTime() + 5000) }); } },
  { id: 'control_store_reuses_approval', scenarioClass: 'replay', expectedFinal: 'ok', expectedStateDelta: 2,
    fault: 'reuse_approval', controlFor: 'replayed_authority',
    run: async (h) => { const id = h.issueApproval(NOTE, 'tenant-a', 'requester-1'); h.approve(id, 'reviewer-2');
      await h.dispatch({ toolName: 'synthetic.note.write', arguments: NOTE, approvalId: id });
      await h.dispatch({ toolName: 'synthetic.note.write', arguments: NOTE, approvalId: id }); } },
  { id: 'control_handler_writes_then_fails', scenarioClass: 'failure', expectedFinal: 'error', expectedStateDelta: 1,
    fault: 'write_then_fail', controlFor: 'state_change_on_failed_step',
    run: async (h) => { const id = h.issueApproval(NOTE, 'tenant-a', 'requester-1'); h.approve(id, 'reviewer-2');
      await h.dispatch({ toolName: 'synthetic.note.write', arguments: NOTE, approvalId: id }); } },
];

/** Runs one scenario on a fresh harness and returns its recorded run, with every observation the harness made. */
export async function runScenarioV2(scenario: ScenarioV2): Promise<RecordedRunV2> {
  const harness = createHarnessV2({ fault: scenario.fault ?? 'none', ...(scenario.harnessOptions ?? {}) });
  await scenario.run(harness);
  const last = harness.steps[harness.steps.length - 1];
  const finalOutcome: RunOutcome = last === undefined ? 'denied' : last.outcome;
  return {
    scenario: scenario.id, scenarioClass: scenario.scenarioClass, tenantId: 'tenant-a', subject: 'requester-1',
    expectedFinal: scenario.expectedFinal, finalOutcome, expectedStateDelta: scenario.expectedStateDelta,
    steps: [...harness.steps], ...(scenario.controlFor !== undefined ? { controlFor: scenario.controlFor } : {}),
  };
}

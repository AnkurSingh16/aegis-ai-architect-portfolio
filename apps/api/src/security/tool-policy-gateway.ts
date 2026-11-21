import { createHash, randomUUID } from 'node:crypto';
import type { RateLimiter } from './rate-limiter.js';
import { isAuthenticatedPrincipal, type VerifiedPrincipal } from '../auth/token.js';

/**
 * Deterministic tool-authorisation gateway for AI agents (C10).
 *
 * Rules, enforced in code and never delegated to a model:
 * - Deny by default. Unknown agents, unknown tools, inactive agents and cross-tenant requests are refused.
 * - Effective scopes are the intersection of the agent's grant and the acting user's grant (least privilege).
 * - Tenant comes only from the trusted request context. Tenant fields in tool arguments are never honoured.
 * - Model-produced arguments may not carry privileges, identities, approvals or secrets.
 * - Side-effecting tools need an approval from the trusted approval store, bound to the exact action digest,
 *   approved by someone other than the agent and the requester, unconsumed, and not expired.
 * - Tool results are only accepted for a run id this gateway issued, once, for that run.
 */

export const DENY_REASONS = [
  'unknown_agent', 'inactive_agent', 'unknown_tool', 'tenant_mismatch', 'tenant_in_arguments',
  'missing_scope', 'privilege_in_arguments', 'secret_in_arguments', 'approval_required',
  'approval_digest_mismatch', 'approval_not_approved', 'approval_self_approved', 'approval_consumed',
  'approval_expired', 'result_unknown_run', 'result_replayed', 'rate_limited', 'rate_limit_unavailable', 'unverified_context',
] as const;
export type DenyReason = typeof DENY_REASONS[number];

export interface ToolDefinition {
  readonly name: string;
  readonly requiredScopes: readonly string[];
  readonly sideEffect: 'read' | 'write' | 'external';
  readonly requiresApproval: boolean;
}

export interface AgentRegistration {
  readonly agentId: string;
  readonly active: boolean;
  readonly scopes: readonly string[];
}

export interface RequestContext {
  readonly tenantId: string;
  readonly userId: string;
  readonly userScopes: readonly string[];
  readonly agentId: string;
  readonly requestedBy: string;
  readonly now: Date;
}

/**
 * Contexts that were built from a verified principal. The gateway accepts only these. A context assembled by hand, or by
 * spreading another context, is not in this set and is denied (unverified_context). Identity and scopes therefore come
 * from the authentication layer, not from whatever a caller puts in an object.
 */
const verifiedContexts = new WeakSet<RequestContext>();

export interface ContextBinding {
  readonly tenantId: string;
  readonly agentId: string;
  readonly now: Date;
}

/** Thrown when a context is requested for a principal the authentication layer did not produce. */
export class UnauthenticatedPrincipalError extends Error {
  readonly name = 'UnauthenticatedPrincipalError';
}

/**
 * The only supported way to build a gateway context. The principal must have been produced by the token verifier, so the
 * identity and scopes are the verified token's. A literal, a copy or a spread principal is refused.
 */
export function verifiedRequestContext(principal: VerifiedPrincipal, binding: ContextBinding): RequestContext {
  if (!isAuthenticatedPrincipal(principal)) throw new UnauthenticatedPrincipalError('principal was not produced by the authentication layer');
  const context: RequestContext = {
    tenantId: binding.tenantId,
    userId: principal.subject,
    userScopes: [...principal.scopes],
    agentId: binding.agentId,
    requestedBy: principal.subject,
    now: binding.now,
  };
  verifiedContexts.add(context);
  return context;
}

export interface ApprovalRecord {
  readonly approvalId: string;
  readonly actionDigest: string;
  readonly status: 'pending' | 'approved' | 'rejected' | 'consumed';
  readonly approvedBy: string;
  readonly expiresAt: Date;
  readonly tenantId: string;
}

/** Approval lookups are performed by the gateway from its trusted store. Model output never supplies one. */
export interface ApprovalStore {
  /** Tenant-scoped read. Returns undefined for other tenants' approvals. */
  get(approvalId: string, tenantId: string): Promise<ApprovalRecord | undefined>;
  /**
   * Atomically marks an approved, unexpired approval as consumed. Returns true only for the single call that wins.
   * Implementations must make this a single conditional write, not a read followed by a write.
   */
  consume(approvalId: string, tenantId: string, now: Date): Promise<boolean>;
}

export interface ToolCall {
  readonly toolName: string;
  readonly arguments: Readonly<Record<string, unknown>>;
  readonly approvalId?: string;
}

export interface Decision {
  readonly allowed: boolean;
  readonly reasons: readonly DenyReason[];
  readonly actionDigest: string;
  readonly effectiveScopes: readonly string[];
  readonly runId?: string;
  readonly audit: {
    readonly tenantId: string; readonly userId: string; readonly agentId: string;
    readonly toolName: string; readonly actionDigest: string; readonly outcome: 'allow' | 'deny';
    readonly reasons: readonly DenyReason[]; readonly at: string;
  };
}

const TENANT_KEYS = /^(tenant|tenant_?id|tenantid|org|organisation|organization)$/i;
const PRIVILEGE_KEYS = /^(scope|scopes|role|roles|permission|permissions|grant|grants|approval|approvals|approved|approvedby|agentid|userid|identity|isadmin|admin)$/i;
const SECRET_KEYS = /(secret|token|password|passwd|api[_-]?key|private[_-]?key|credential|authorization)/i;

/** Canonical JSON: sorted object keys, so equal actions produce equal digests. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.keys(value as object).sort().map((key) =>
    `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`);
  return `{${entries.join(',')}}`;
}

export function actionDigest(tenantId: string, toolName: string, args: Readonly<Record<string, unknown>>): string {
  return createHash('sha256').update(canonicalJson({ tenantId, toolName, arguments: args })).digest('hex');
}

function findKeys(value: unknown, pattern: RegExp): string[] {
  const hits: string[] = [];
  const walk = (node: unknown): void => {
    if (node === null || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach(walk); return; }
    for (const [key, child] of Object.entries(node as Record<string, unknown>)) {
      if (pattern.test(key)) hits.push(key);
      walk(child);
    }
  };
  walk(value);
  return hits;
}

const intersect = (a: readonly string[], b: readonly string[]): string[] => a.filter((scope) => b.includes(scope)).sort();

export class ToolGateway {
  private readonly runs = new Map<string, { tenantId: string; consumed: boolean }>();

  constructor(
    private readonly tools: ReadonlyMap<string, ToolDefinition>,
    private readonly agents: ReadonlyMap<string, AgentRegistration>,
    private readonly approvals: ApprovalStore,
    /** Optional. Limits calls per tenant and agent. A limited call is denied before any other check or any approval use. */
    private readonly limiter?: RateLimiter,
  ) {
    // Registration fails closed: a tool with side effects must require approval. An unsafe registration never reaches a caller.
    for (const tool of tools.values()) {
      if (!['read', 'write', 'external'].includes(tool.sideEffect)) throw new RangeError(`tool ${tool.name} has an unknown side effect`);
      if (tool.sideEffect !== 'read' && !tool.requiresApproval) {
        throw new RangeError(`tool ${tool.name} has side effects (${tool.sideEffect}) and must require approval`);
      }
    }
  }

  private denied(call: ToolCall, context: RequestContext, digest: string, reasons: DenyReason[]): Decision {
    return {
      allowed: false, reasons, actionDigest: digest, effectiveScopes: [],
      audit: {
        tenantId: context.tenantId, userId: context.userId, agentId: context.agentId, toolName: call.toolName,
        actionDigest: digest, outcome: 'deny', reasons, at: context.now.toISOString(),
      },
    };
  }

  async authorise(call: ToolCall, context: RequestContext): Promise<Decision> {
    const digest = actionDigest(context.tenantId, call.toolName, call.arguments);
    if (!verifiedContexts.has(context)) return this.denied(call, context, digest, ['unverified_context']);
    // Only a registered, active agent can spend a token, so unknown agent ids cannot create limiter state.
    const limited = this.agents.get(context.agentId);
    if (this.limiter !== undefined && limited !== undefined && limited.active) {
      let allowed: boolean;
      try {
        allowed = await this.limiter.take({ tenantId: context.tenantId, agentId: context.agentId, now: context.now });
      } catch {
        // The limiter could not decide. Fail closed.
        return this.denied(call, context, digest, ['rate_limit_unavailable']);
      }
      if (!allowed) return this.denied(call, context, digest, ['rate_limited']);
    }
    const reasons: DenyReason[] = [];
    const agent = this.agents.get(context.agentId);
    const tool = this.tools.get(call.toolName);
    // Fail closed: a side-effecting tool needs an approval even if its definition says otherwise now.
    const approvalRequired = tool !== undefined && (tool.requiresApproval || tool.sideEffect !== 'read');
    let effective: string[] = [];

    if (!agent) reasons.push('unknown_agent');
    else if (!agent.active) reasons.push('inactive_agent');
    if (!tool) reasons.push('unknown_tool');

    if (agent && tool) {
      effective = intersect(agent.scopes, context.userScopes);
      if (!tool.requiredScopes.every((scope) => effective.includes(scope))) reasons.push('missing_scope');
    }

    if (findKeys(call.arguments, TENANT_KEYS).length > 0) reasons.push('tenant_in_arguments');
    if (findKeys(call.arguments, PRIVILEGE_KEYS).length > 0) reasons.push('privilege_in_arguments');
    if (findKeys(call.arguments, SECRET_KEYS).length > 0) reasons.push('secret_in_arguments');

    if (approvalRequired) {
      reasons.push(...(await this.checkApproval(call, context, digest)));
    }

    const allowed = reasons.length === 0 && tool !== undefined && agent !== undefined;
    let runId: string | undefined;
    if (allowed) {
      if (approvalRequired && call.approvalId !== undefined) {
        // Single atomic consume. If another request won the race, fail closed.
        const consumed = await this.approvals.consume(call.approvalId, context.tenantId, context.now);
        if (!consumed) reasons.push('approval_consumed');
      }
      if (reasons.length === 0) {
        runId = randomUUID();
        this.runs.set(runId, { tenantId: context.tenantId, consumed: false });
      }
    }
    const outcome = runId !== undefined ? 'allow' : 'deny';
    return {
      allowed: runId !== undefined,
      reasons: [...new Set(reasons)],
      actionDigest: digest,
      effectiveScopes: effective,
      runId,
      audit: {
        tenantId: context.tenantId, userId: context.userId, agentId: context.agentId, toolName: call.toolName,
        actionDigest: digest, outcome, reasons: [...new Set(reasons)], at: context.now.toISOString(),
      },
    };
  }

  /** Accepts a tool result only for a run this gateway issued, once, for the same tenant. */
  acceptResult(runId: string, tenantId: string): { accepted: boolean; reason?: DenyReason } {
    const run = this.runs.get(runId);
    if (!run) return { accepted: false, reason: 'result_unknown_run' };
    if (run.consumed) return { accepted: false, reason: 'result_replayed' };
    if (run.tenantId !== tenantId) return { accepted: false, reason: 'tenant_mismatch' };
    run.consumed = true;
    return { accepted: true };
  }

  private async checkApproval(call: ToolCall, context: RequestContext, digest: string): Promise<DenyReason[]> {
    if (call.approvalId === undefined) return ['approval_required'];
    const approval = await this.approvals.get(call.approvalId, context.tenantId);
    if (!approval) return ['approval_required'];
    const reasons: DenyReason[] = [];
    if (approval.tenantId !== context.tenantId) reasons.push('tenant_mismatch');
    if (approval.actionDigest !== digest) reasons.push('approval_digest_mismatch');
    if (approval.status === 'consumed') reasons.push('approval_consumed');
    else if (approval.status !== 'approved') reasons.push('approval_not_approved');
    if (approval.approvedBy === context.requestedBy || approval.approvedBy === context.agentId) reasons.push('approval_self_approved');
    if (context.now.getTime() >= approval.expiresAt.getTime()) reasons.push('approval_expired');
    return reasons;
  }
}

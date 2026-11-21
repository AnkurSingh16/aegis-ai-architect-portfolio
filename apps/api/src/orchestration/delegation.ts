import { createHash } from 'node:crypto';
import type {
  AgentDefinition, DelegationChain, DelegationLink, ExecutionRecord, ExecutionState, Grant, TypedEnvelope,
} from './types.js';

/**
 * P4 port of the C8 pure rules from commit 08c305f (design branch c8-design-foundation, PR #77). The logic is unchanged. This file is
 * copied so that P4 can persist the approved contracts without depending on an unmerged branch. Re-port if PR #77 changes.
 *
 * Pure C8 rules. Every function takes values and returns values. None reads state, performs I/O, calls a tool or connects to MCP.
 *
 * Two different questions are answered by different functions, and they must not be confused:
 * - STRUCTURE (`checkEnvelopeStructure`): is this message well formed? It proves nothing about authority.
 * - AUTHORISATION (`authoriseEnvelope`): did the orchestrator grant this exact destination, action, arguments and chain, and has that
 *   grant not been used? Only an open grant authorises a message. A message that passes structure checks but has no matching open
 *   grant is refused.
 *
 * Budgets live in `ExecutionState`, which is threaded through every decision. Branches of a delegation tree share one state, so the
 * global delegation count cannot reset because a new chain starts.
 */

export type DelegationRefusal =
  | 'discontinuous_chain'
  | 'unknown_agent'
  | 'self_delegation'
  | 'cycle'
  | 'depth_exceeded'
  | 'delegation_budget_exceeded'
  | 'scope_escalation';

export type DelegationDecision =
  | { readonly allowed: true; readonly link: DelegationLink }
  | { readonly allowed: false; readonly reason: DelegationRefusal };

export type GrantRefusal = 'empty_chain' | 'scope_escalation';

export type StructureRefusal = 'unexpected_fields' | 'malformed';

export type AuthorisationRefusal =
  | StructureRefusal
  | 'authority_mismatch'
  | 'not_granted'
  | 'grant_consumed'
  | 'step_budget_exceeded';

const sortedUnique = (values: readonly string[]): string[] => [...new Set(values)].sort();

/** The scopes an agent may carry, given what the delegator carries and what the delegate is registered for. */
export function effectiveScopes(delegatorScopes: readonly string[], delegateRegistered: readonly string[]): string[] {
  const registered = new Set(delegateRegistered);
  return sortedUnique(delegatorScopes.filter((scope) => registered.has(scope)));
}

/** True when every requested scope is inside the allowed set. */
export function isSubset(requested: readonly string[], allowed: readonly string[]): boolean {
  const permitted = new Set(allowed);
  return requested.every((scope) => permitted.has(scope));
}

/** The agent that currently holds a chain: the root when the chain is empty, otherwise the last hop's destination. */
export function holderOf(rootAgent: string, chain: DelegationChain): string {
  return chain.length === 0 ? rootAgent : chain[chain.length - 1].to;
}

/** Agents named in a chain, in order, starting with the root. */
export function agentsInChain(rootAgent: string, chain: DelegationChain): string[] {
  return [rootAgent, ...chain.map((link) => link.to)];
}

/** Scopes held by the agent at the end of a chain. */
function holderScopes(record: ExecutionRecord, agents: ReadonlyMap<string, AgentDefinition>, chain: DelegationChain): string[] {
  if (chain.length > 0) return [...chain[chain.length - 1].effectiveScopes];
  const root = agents.get(record.rootAgent);
  return root ? effectiveScopes(record.principalScopes, root.registeredScopes) : [];
}

/**
 * Decides whether the current holder may delegate `requestedScopes` to `to`. Checks run in a fixed order and the first failure is
 * returned: continuity, known agents, self-delegation, cycles on this branch, depth on this branch, the GLOBAL delegation budget held
 * in `state`, then scope subset. Nothing is changed. On an allowed decision the caller must record it with `recordDelegation` and
 * extend the chain with `extendChain`.
 */
export function decideDelegation(input: {
  readonly record: ExecutionRecord;
  readonly state: ExecutionState;
  readonly chain: DelegationChain;
  readonly agents: ReadonlyMap<string, AgentDefinition>;
  readonly from: string;
  readonly to: string;
  readonly requestedScopes: readonly string[];
}): DelegationDecision {
  const { record, state, chain, agents, from, to, requestedScopes } = input;

  if (from !== holderOf(record.rootAgent, chain)) return { allowed: false, reason: 'discontinuous_chain' };

  const delegator = agents.get(from);
  const delegate = agents.get(to);
  if (!delegator || !delegate) return { allowed: false, reason: 'unknown_agent' };

  if (to === from) return { allowed: false, reason: 'self_delegation' };
  if (agentsInChain(record.rootAgent, chain).includes(to)) return { allowed: false, reason: 'cycle' };

  // Depth is a property of one branch, so it is measured against this chain.
  if (chain.length + 1 > record.limits.maxDepth) return { allowed: false, reason: 'depth_exceeded' };

  // The delegation budget is a property of the whole execution, so it is measured against the threaded state.
  if (state.delegationsIssued >= record.limits.maxDelegations) return { allowed: false, reason: 'delegation_budget_exceeded' };

  const carried = effectiveScopes(holderScopes(record, agents, chain), delegate.registeredScopes);
  if (!isSubset(requestedScopes, carried)) return { allowed: false, reason: 'scope_escalation' };

  return { allowed: true, link: { from, to, effectiveScopes: sortedUnique(requestedScopes) } };
}

/** Counts one delegation against the global budget. Returns a new state; the input is not changed. */
export function recordDelegation(state: ExecutionState): ExecutionState {
  return { ...state, delegationsIssued: state.delegationsIssued + 1 };
}

/** Returns a new chain with one more link. The input chain is not changed. */
export function extendChain(chain: DelegationChain, link: DelegationLink): DelegationChain {
  return [...chain, link];
}

/**
 * Issues a grant for one concrete action at the end of an already-extended chain. The grant binds the sender (the holder before the
 * last hop), the destination, the action, the arguments digest, the chain and the principal. It is refused unless the destination's
 * effective scopes cover what the action requires. Grants are not delegations and do not count against the delegation budget.
 */
export function issueGrant(input: {
  readonly record: ExecutionRecord;
  readonly state: ExecutionState;
  readonly chain: DelegationChain;
  readonly kind: 'request' | 'result';
  readonly action: string;
  readonly argumentsDigest: string;
  readonly requiredScopes: readonly string[];
}): { readonly ok: true; readonly grant: Grant; readonly state: ExecutionState } | { readonly ok: false; readonly reason: GrantRefusal } {
  const { record, state, chain, kind, action, argumentsDigest, requiredScopes } = input;
  if (chain.length === 0) return { ok: false, reason: 'empty_chain' };
  const last = chain[chain.length - 1];
  if (!isSubset(requiredScopes, last.effectiveScopes)) return { ok: false, reason: 'scope_escalation' };

  const from = chain.length === 1 ? record.rootAgent : chain[chain.length - 2].to;
  const body = {
    kind,
    executionId: record.executionId,
    tenantId: record.tenantId,
    principalRef: record.principalRef,
    chainDigest: chainDigest(chain),
    depth: chain.length,
    from,
    to: last.to,
    action,
    argumentsDigest,
    requiredScopes: sortedUnique(requiredScopes),
  };
  // The sequence number makes two otherwise identical grants distinct, so each can be consumed once.
  const sequence = state.openGrants.length + state.consumedGrants.length;
  const grant: Grant = { grantId: sha256(canonicalJson({ ...body, sequence })), ...body };
  return { ok: true, grant, state: { ...state, openGrants: [...state.openGrants, grant] } };
}

/** Stable digest of a chain. Equal chains give equal digests regardless of how the scopes were supplied. */
export function chainDigest(chain: DelegationChain): string {
  const canonical = chain.map((link) => ({ from: link.from, to: link.to, effectiveScopes: sortedUnique(link.effectiveScopes) }));
  return sha256(JSON.stringify(canonical));
}

/** Stable digest of an action's arguments, for the envelope. Keys are sorted at every level. */
export function argumentsDigest(args: Readonly<Record<string, unknown>>): string {
  return sha256(canonicalJson(args));
}

/** Digest an approval would bind to: tenant, principal, delegation chain, action and arguments. */
export function approvalBindingDigest(input: {
  readonly tenantId: string;
  readonly principalRef: string;
  readonly chain: DelegationChain;
  readonly action: string;
  readonly argumentsDigest: string;
}): string {
  return sha256(canonicalJson({
    tenantId: input.tenantId,
    principalRef: input.principalRef,
    chainDigest: chainDigest(input.chain),
    action: input.action,
    argumentsDigest: input.argumentsDigest,
  }));
}

/** The ten fields an envelope may carry. Anything else is refused by the structure check. */
export const ENVELOPE_FIELDS = [
  'kind', 'executionId', 'tenantId', 'principalRef', 'from', 'to', 'depth', 'chainDigest', 'action', 'argumentsDigest',
] as const;

/**
 * STRUCTURE ONLY. Proves that an incoming value has exactly the expected fields with the expected types. It does not prove that the
 * message is authorised, and a structurally valid envelope must never be acted on without `authoriseEnvelope`.
 */
export function checkEnvelopeStructure(value: unknown): { readonly ok: true; readonly envelope: TypedEnvelope } | { readonly ok: false; readonly reason: StructureRefusal } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return { ok: false, reason: 'malformed' };
  const candidate = value as Record<string, unknown>;
  const keys = Object.keys(candidate);
  if (keys.length !== ENVELOPE_FIELDS.length || keys.some((key) => !(ENVELOPE_FIELDS as readonly string[]).includes(key))) {
    return { ok: false, reason: 'unexpected_fields' };
  }
  if (candidate.kind !== 'request' && candidate.kind !== 'result') return { ok: false, reason: 'malformed' };
  const strings = ['executionId', 'tenantId', 'principalRef', 'from', 'to', 'chainDigest', 'action', 'argumentsDigest'] as const;
  if (!Number.isInteger(candidate.depth) || (candidate.depth as number) < 0) return { ok: false, reason: 'malformed' };
  if (strings.some((field) => typeof candidate[field] !== 'string')) return { ok: false, reason: 'malformed' };
  return { ok: true, envelope: candidate as unknown as TypedEnvelope };
}

/**
 * AUTHORISATION. Proves that the orchestrator granted this exact message and that the grant has not been used. In order:
 * 1. structure (refused as malformed or unexpected fields);
 * 2. the envelope belongs to this execution, tenant and principal (`authority_mismatch`);
 * 3. the global step budget is not spent;
 * 4. an open grant matches every field, including the sender, destination, action, arguments digest and chain digest (`not_granted`
 *    when none matches, `grant_consumed` when only a consumed grant matches).
 * On success the matched grant is consumed and the step is counted. The input state is not changed.
 */
export function authoriseEnvelope(input: {
  readonly value: unknown;
  readonly record: ExecutionRecord;
  readonly state: ExecutionState;
}): { readonly ok: true; readonly state: ExecutionState; readonly grant: Grant } | { readonly ok: false; readonly reason: AuthorisationRefusal } {
  const { value, record, state } = input;
  const structure = checkEnvelopeStructure(value);
  if (!structure.ok) return { ok: false, reason: structure.reason };
  const envelope = structure.envelope;

  if (envelope.executionId !== record.executionId || envelope.tenantId !== record.tenantId || envelope.principalRef !== record.principalRef) {
    return { ok: false, reason: 'authority_mismatch' };
  }
  if (state.stepsTaken >= record.limits.maxSteps) return { ok: false, reason: 'step_budget_exceeded' };

  const matches = (grant: Grant) => grant.kind === envelope.kind && grant.executionId === envelope.executionId
    && grant.tenantId === envelope.tenantId && grant.principalRef === envelope.principalRef && grant.chainDigest === envelope.chainDigest
    && grant.depth === envelope.depth && grant.from === envelope.from && grant.to === envelope.to && grant.action === envelope.action
    && grant.argumentsDigest === envelope.argumentsDigest;

  const index = state.openGrants.findIndex(matches);
  if (index === -1) {
    const replayed = state.consumedGrants.some(matches);
    return { ok: false, reason: replayed ? 'grant_consumed' : 'not_granted' };
  }
  const grant = state.openGrants[index];
  return {
    ok: true,
    grant,
    state: {
      ...state,
      stepsTaken: state.stepsTaken + 1,
      openGrants: state.openGrants.filter((_, position) => position !== index),
      consumedGrants: [...state.consumedGrants, grant],
    },
  };
}

/** Canonical JSON: object keys sorted recursively. Arrays keep their order. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.keys(value as Record<string, unknown>).sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`);
  return `{${entries.join(',')}}`;
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

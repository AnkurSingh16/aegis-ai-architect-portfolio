import { createHash } from 'node:crypto';
import type { AgentDefinition, DelegationChain, DelegationLink, ExecutionLimits, ExecutionRecord, TypedEnvelope } from './types.js';

/**
 * Pure delegation rules. Every function here takes values and returns values. None reads state, performs I/O or calls a tool.
 *
 * Non-escalation: a delegate's effective scopes are the intersection of the delegator's effective scopes and the delegate's
 * registered scopes. A request may only ask for scopes inside that intersection. Scopes are never added along a chain.
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

export const EMPTY_CHAIN: DelegationChain = [];

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

/** Agents named in a chain, in order, starting with the root. */
export function agentsInChain(rootAgent: string, chain: DelegationChain): string[] {
  return [rootAgent, ...chain.map((link) => link.to)];
}

/**
 * Decides whether `from` may delegate `requestedScopes` to `to` at the end of `chain`. Checks run in a fixed order and the first
 * failure is returned, so refusals are deterministic. Nothing is changed; the caller extends the chain only on an allowed decision.
 */
export function decideDelegation(input: {
  readonly record: ExecutionRecord;
  readonly chain: DelegationChain;
  readonly agents: ReadonlyMap<string, AgentDefinition>;
  readonly from: string;
  readonly to: string;
  readonly requestedScopes: readonly string[];
}): DelegationDecision {
  const { record, chain, agents, from, to, requestedScopes } = input;
  const current = chain.length === 0 ? record.rootAgent : chain[chain.length - 1].to;

  if (from !== current) return { allowed: false, reason: 'discontinuous_chain' };

  const delegator = agents.get(from);
  const delegate = agents.get(to);
  if (!delegator || !delegate) return { allowed: false, reason: 'unknown_agent' };

  if (to === from) return { allowed: false, reason: 'self_delegation' };
  if (agentsInChain(record.rootAgent, chain).includes(to)) return { allowed: false, reason: 'cycle' };

  const depth = chain.length + 1;
  if (depth > record.limits.maxDepth) return { allowed: false, reason: 'depth_exceeded' };
  if (depth > record.limits.maxDelegations) return { allowed: false, reason: 'delegation_budget_exceeded' };

  const delegatorEffective = chain.length === 0
    ? effectiveScopes(record.principalScopes, delegator.registeredScopes)
    : [...chain[chain.length - 1].effectiveScopes];
  const carried = effectiveScopes(delegatorEffective, delegate.registeredScopes);
  if (!isSubset(requestedScopes, carried)) return { allowed: false, reason: 'scope_escalation' };

  return { allowed: true, link: { from, to, effectiveScopes: sortedUnique(requestedScopes) } };
}

/** Returns a new chain with one more link. The input chain is not changed. */
export function extendChain(chain: DelegationChain, link: DelegationLink): DelegationChain {
  return [...chain, link];
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

/** Builds an envelope from the orchestrator's record. Callers supply only the hop, the action and the argument digest. */
export function buildEnvelope(input: {
  readonly kind: 'request' | 'result';
  readonly record: ExecutionRecord;
  readonly chain: DelegationChain;
  readonly from: string;
  readonly to: string;
  readonly action: string;
  readonly argumentsDigest: string;
}): TypedEnvelope {
  return {
    kind: input.kind,
    executionId: input.record.executionId,
    tenantId: input.record.tenantId,
    principalRef: input.record.principalRef,
    from: input.from,
    to: input.to,
    depth: input.chain.length,
    chainDigest: chainDigest(input.chain),
    action: input.action,
    argumentsDigest: input.argumentsDigest,
  };
}

const ENVELOPE_KEYS = ['kind', 'executionId', 'tenantId', 'principalRef', 'from', 'to', 'depth', 'chainDigest', 'action', 'argumentsDigest'];

export type EnvelopeRefusal =
  | 'unexpected_fields'
  | 'malformed'
  | 'discontinuous_chain'
  | 'authority_mismatch'
  | 'step_budget_exceeded';

/**
 * Checks an envelope against the orchestrator's record and the chain it actually holds. Any extra key is refused, so content cannot
 * smuggle scopes, tenant, principal or approval fields. Every field must have the expected type. Authority fields must equal the
 * orchestrator's values exactly, and `from` must be the agent that currently holds the chain.
 */
export function validateEnvelope(input: {
  readonly envelope: unknown;
  readonly record: ExecutionRecord;
  readonly chain: DelegationChain;
  readonly stepsTaken: number;
}): { readonly ok: true } | { readonly ok: false; readonly reason: EnvelopeRefusal } {
  const { envelope, record, chain, stepsTaken } = input;
  if (typeof envelope !== 'object' || envelope === null || Array.isArray(envelope)) return { ok: false, reason: 'malformed' };
  const candidate = envelope as Record<string, unknown>;
  const keys = Object.keys(candidate);
  if (keys.length !== ENVELOPE_KEYS.length || keys.some((key) => !ENVELOPE_KEYS.includes(key))) {
    return { ok: false, reason: 'unexpected_fields' };
  }
  const stringFields = ['executionId', 'tenantId', 'principalRef', 'from', 'to', 'chainDigest', 'action', 'argumentsDigest'] as const;
  if (candidate.kind !== 'request' && candidate.kind !== 'result') return { ok: false, reason: 'malformed' };
  if (!Number.isInteger(candidate.depth) || stringFields.some((field) => typeof candidate[field] !== 'string')) {
    return { ok: false, reason: 'malformed' };
  }
  const current = chain.length === 0 ? record.rootAgent : chain[chain.length - 1].to;
  if (candidate.from !== current) return { ok: false, reason: 'discontinuous_chain' };

  const expected = buildEnvelope({
    kind: candidate.kind,
    record,
    chain,
    from: candidate.from as string,
    to: candidate.to as string,
    action: candidate.action as string,
    argumentsDigest: candidate.argumentsDigest as string,
  });
  const authorityFields = ['executionId', 'tenantId', 'principalRef', 'depth', 'chainDigest'] as const;
  for (const field of authorityFields) {
    if (candidate[field] !== expected[field]) return { ok: false, reason: 'authority_mismatch' };
  }
  if (stepsTaken >= record.limits.maxSteps) return { ok: false, reason: 'step_budget_exceeded' };
  return { ok: true };
}

export function withinStepBudget(stepsTaken: number, limits: ExecutionLimits): boolean {
  return stepsTaken < limits.maxSteps;
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** Canonical JSON: object keys sorted recursively. Arrays keep their order. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.keys(value as Record<string, unknown>).sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`);
  return `{${entries.join(',')}}`;
}

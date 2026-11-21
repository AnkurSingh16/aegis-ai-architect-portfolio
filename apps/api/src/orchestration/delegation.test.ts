import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  agentsInChain, approvalBindingDigest, argumentsDigest, authoriseEnvelope, checkEnvelopeStructure, chainDigest, decideDelegation,
  effectiveScopes, extendChain, holderOf, isSubset, issueGrant, recordDelegation,
} from './delegation.js';
import { type AgentDefinition, type DelegationChain, type ExecutionRecord, type ExecutionState, initialExecutionState } from './types.js';

// Pure, deterministic tests for the C8 design. No database, no MCP, no tool invocation. State is threaded through every decision,
// exactly as a caller must do, so a test that discards state would show up as a reset.

const agents = new Map<string, AgentDefinition>([
  ['triage', { id: 'triage', role: 'triage', registeredScopes: ['read:cases', 'read:documents'] }],
  ['retrieval', { id: 'retrieval', role: 'retrieval', registeredScopes: ['read:documents'] }],
  ['reviewer', { id: 'reviewer', role: 'reviewer', registeredScopes: ['read:cases'] }],
  ['writer', { id: 'writer', role: 'triage', registeredScopes: ['read:cases', 'write:cases'] }],
]);

const record: ExecutionRecord = {
  executionId: 'exec-1',
  tenantId: 'tenant-a',
  principalRef: 'p-digest-1',
  principalScopes: ['read:cases', 'read:documents'],
  rootAgent: 'triage',
  limits: { maxDepth: 3, maxDelegations: 3, maxSteps: 10 },
};

const decide = (state: ExecutionState, chain: DelegationChain, from: string, to: string, requestedScopes: string[], rec: ExecutionRecord = record) =>
  decideDelegation({ record: rec, state, chain, agents, from, to, requestedScopes });

/** Applies one allowed hop the way a caller must: decide, record against the state, extend the chain. */
function hop(state: ExecutionState, chain: DelegationChain, from: string, to: string, scopes: string[], rec: ExecutionRecord = record) {
  const decision = decide(state, chain, from, to, scopes, rec);
  if (!decision.allowed) throw new Error(`setup refused: ${decision.reason}`);
  return { state: recordDelegation(state), chain: extendChain(chain, decision.link) };
}

describe('non-escalating scopes', () => {
  it('intersects the principal with the root registration, then the delegate registration', () => {
    expect(effectiveScopes(['read:cases', 'read:documents', 'write:cases'], ['read:cases', 'read:documents'])).toEqual(['read:cases', 'read:documents']);
    expect(effectiveScopes(['read:cases'], ['read:documents'])).toEqual([]);
  });

  it('allows a delegate to receive a scope it is registered for and the holder carries', () => {
    expect(decide(initialExecutionState, [], 'triage', 'retrieval', ['read:documents'])).toEqual({
      allowed: true, link: { from: 'triage', to: 'retrieval', effectiveScopes: ['read:documents'] },
    });
  });

  it('refuses a scope the delegate is not registered for', () => {
    expect(decide(initialExecutionState, [], 'triage', 'retrieval', ['read:cases'])).toEqual({ allowed: false, reason: 'scope_escalation' });
  });

  it('refuses a scope the principal does not hold, even when the agent is registered for it', () => {
    expect(decide(initialExecutionState, [], 'triage', 'writer', ['write:cases'])).toEqual({ allowed: false, reason: 'scope_escalation' });
  });

  it('cannot widen along a chain: the second hop is limited by the first', () => {
    const first = hop(initialExecutionState, [], 'triage', 'retrieval', ['read:documents']);
    expect(decide(first.state, first.chain, 'retrieval', 'reviewer', ['read:cases'])).toEqual({ allowed: false, reason: 'scope_escalation' });
    expect(decide(first.state, first.chain, 'retrieval', 'reviewer', [])).toEqual({
      allowed: true, link: { from: 'retrieval', to: 'reviewer', effectiveScopes: [] },
    });
  });

  it('isSubset is exact and treats an empty request as allowed', () => {
    expect(isSubset(['a'], ['a', 'b'])).toBe(true);
    expect(isSubset(['a', 'c'], ['a', 'b'])).toBe(false);
    expect(isSubset([], [])).toBe(true);
  });
});

describe('global execution budget across branches', () => {
  const budgetTwo: ExecutionRecord = { ...record, limits: { maxDepth: 3, maxDelegations: 2, maxSteps: 10 } };

  it('counts delegations across sibling branches, so each new chain shares one budget', () => {
    const branchOne = hop(initialExecutionState, [], 'triage', 'retrieval', ['read:documents'], budgetTwo);
    // A sibling branch starts from the root again, but the state already records one delegation.
    const branchTwo = hop(branchOne.state, [], 'triage', 'reviewer', ['read:cases'], budgetTwo);
    expect(branchTwo.state.delegationsIssued).toBe(2);
    // Each chain has length one, so a per-chain check would allow a third sibling. The global budget refuses it.
    expect(decide(branchTwo.state, [], 'triage', 'retrieval', ['read:documents'], budgetTwo)).toEqual({ allowed: false, reason: 'delegation_budget_exceeded' });
  });

  it('does not reset when a deeper branch is followed by another branch', () => {
    const deep = hop(initialExecutionState, [], 'triage', 'retrieval', ['read:documents'], record);
    const deeper = hop(deep.state, deep.chain, 'retrieval', 'reviewer', [], record);
    expect(deeper.state.delegationsIssued).toBe(2);
    // Budget is 3. One more delegation is allowed anywhere in the execution, and then none.
    const last = hop(deeper.state, [], 'triage', 'reviewer', ['read:cases'], record);
    expect(last.state.delegationsIssued).toBe(3);
    expect(decide(last.state, [], 'triage', 'reviewer', ['read:cases'], record)).toEqual({ allowed: false, reason: 'delegation_budget_exceeded' });
  });

  it('discarding the state would reset the count, which is why state must be threaded', () => {
    // This test documents the failure mode the design forbids. A caller that passes a fresh state reopens the budget.
    const used = hop(initialExecutionState, [], 'triage', 'retrieval', ['read:documents'], budgetTwo);
    const used2 = hop(used.state, [], 'triage', 'reviewer', ['read:cases'], budgetTwo);
    expect(decide(used2.state, [], 'triage', 'retrieval', ['read:documents'], budgetTwo).allowed).toBe(false);
    expect(decide(initialExecutionState, [], 'triage', 'retrieval', ['read:documents'], budgetTwo).allowed).toBe(true);
  });
});

describe('per-branch depth and cycles', () => {
  it('refuses a hop beyond the maximum depth of its own branch, even when the global budget has room', () => {
    const shallow: ExecutionRecord = { ...record, limits: { maxDepth: 1, maxDelegations: 9, maxSteps: 10 } };
    const first = hop(initialExecutionState, [], 'triage', 'retrieval', ['read:documents'], shallow);
    expect(decide(first.state, first.chain, 'retrieval', 'reviewer', [], shallow)).toEqual({ allowed: false, reason: 'depth_exceeded' });
  });

  it('refuses delegation back to the root agent', () => {
    const first = hop(initialExecutionState, [], 'triage', 'retrieval', ['read:documents']);
    expect(decide(first.state, first.chain, 'retrieval', 'triage', ['read:documents'])).toEqual({ allowed: false, reason: 'cycle' });
  });

  it('refuses a repeat of an agent that appears mid-chain', () => {
    const a = hop(initialExecutionState, [], 'triage', 'retrieval', ['read:documents']);
    const b = hop(a.state, a.chain, 'retrieval', 'reviewer', []);
    expect(decide(b.state, b.chain, 'reviewer', 'retrieval', [])).toEqual({ allowed: false, reason: 'cycle' });
  });

  it('allows the same agent on two sibling branches, since that is not a cycle', () => {
    const one = hop(initialExecutionState, [], 'triage', 'retrieval', ['read:documents']);
    expect(decide(one.state, [], 'triage', 'retrieval', ['read:documents']).allowed).toBe(true);
  });

  it('refuses self-delegation, a hop from a non-holder, and unknown agents', () => {
    expect(decide(initialExecutionState, [], 'triage', 'triage', [])).toEqual({ allowed: false, reason: 'self_delegation' });
    const first = hop(initialExecutionState, [], 'triage', 'retrieval', ['read:documents']);
    expect(decide(first.state, first.chain, 'triage', 'reviewer', [])).toEqual({ allowed: false, reason: 'discontinuous_chain' });
    expect(decide(initialExecutionState, [], 'triage', 'ghost', [])).toEqual({ allowed: false, reason: 'unknown_agent' });
  });

  it('reports the holder and the agents on a chain', () => {
    const one = hop(initialExecutionState, [], 'triage', 'retrieval', ['read:documents']);
    expect(holderOf('triage', [])).toBe('triage');
    expect(holderOf('triage', one.chain)).toBe('retrieval');
    expect(agentsInChain('triage', one.chain)).toEqual(['triage', 'retrieval']);
  });
});

describe('structure is not authorisation', () => {
  const chainOne = (): DelegationChain => [{ from: 'triage', to: 'retrieval', effectiveScopes: ['read:documents'] }];
  const args = argumentsDigest({ query: 'refund policy' });

  /** A structurally valid envelope that nobody granted. */
  const ungranted = () => ({
    kind: 'request', executionId: 'exec-1', tenantId: 'tenant-a', principalRef: 'p-digest-1', from: 'triage', to: 'retrieval',
    depth: 1, chainDigest: chainDigest(chainOne()), action: 'documents.search', argumentsDigest: args,
  });

  it('checkEnvelopeStructure accepts a well-formed message and makes no authority claim', () => {
    expect(checkEnvelopeStructure(ungranted()).ok).toBe(true);
  });

  it('checkEnvelopeStructure refuses extra fields, missing fields, wrong types and unknown kinds', () => {
    expect(checkEnvelopeStructure({ ...ungranted(), scopes: ['write:cases'] })).toEqual({ ok: false, reason: 'unexpected_fields' });
    const missing: Record<string, unknown> = { ...ungranted() };
    delete missing.action;
    expect(checkEnvelopeStructure(missing)).toEqual({ ok: false, reason: 'unexpected_fields' });
    expect(checkEnvelopeStructure({ ...ungranted(), depth: '1' })).toEqual({ ok: false, reason: 'malformed' });
    expect(checkEnvelopeStructure({ ...ungranted(), kind: 'command' })).toEqual({ ok: false, reason: 'malformed' });
    expect(checkEnvelopeStructure(null)).toEqual({ ok: false, reason: 'malformed' });
  });

  it('a structurally valid envelope with no grant is refused as not granted', () => {
    expect(checkEnvelopeStructure(ungranted()).ok).toBe(true);
    expect(authoriseEnvelope({ value: ungranted(), record, state: initialExecutionState })).toEqual({ ok: false, reason: 'not_granted' });
  });
});

describe('grants authorise exact messages, once', () => {
  /** Orchestrator-side setup: one allowed hop, then a grant for one action at its destination. */
  function granted(overrides: { action?: string; requiredScopes?: string[]; rec?: ExecutionRecord } = {}) {
    const rec = overrides.rec ?? record;
    const first = hop(initialExecutionState, [], 'triage', 'retrieval', ['read:documents'], rec);
    const issued = issueGrant({
      record: rec, state: first.state, chain: first.chain, kind: 'request', action: overrides.action ?? 'documents.search',
      argumentsDigest: argumentsDigest({ query: 'refund policy' }), requiredScopes: overrides.requiredScopes ?? ['read:documents'],
    });
    if (!issued.ok) throw new Error(`setup refused: ${issued.reason}`);
    return { state: issued.state, grant: issued.grant, chain: first.chain, rec };
  }

  const envelopeFor = (g: ReturnType<typeof granted>, overrides: Record<string, unknown> = {}) => ({
    kind: 'request', executionId: g.rec.executionId, tenantId: g.rec.tenantId, principalRef: g.rec.principalRef,
    from: 'triage', to: 'retrieval', depth: 1, chainDigest: chainDigest(g.chain), action: 'documents.search',
    argumentsDigest: argumentsDigest({ query: 'refund policy' }), ...overrides,
  });

  it('authorises the granted message once and counts the step', () => {
    const g = granted();
    const result = authoriseEnvelope({ value: envelopeFor(g), record: g.rec, state: g.state });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.state.stepsTaken).toBe(1);
    expect(result.state.openGrants).toHaveLength(0);
    expect(result.state.consumedGrants).toHaveLength(1);
  });

  it('refuses a replay of the same envelope as consumed, not as unknown', () => {
    const g = granted();
    const first = authoriseEnvelope({ value: envelopeFor(g), record: g.rec, state: g.state });
    if (!first.ok) throw new Error('setup');
    expect(authoriseEnvelope({ value: envelopeFor(g), record: g.rec, state: first.state })).toEqual({ ok: false, reason: 'grant_consumed' });
  });

  it('refuses a different destination, sender, action, arguments or chain', () => {
    const g = granted();
    const refuse = (overrides: Record<string, unknown>) => authoriseEnvelope({ value: envelopeFor(g, overrides), record: g.rec, state: g.state });
    expect(refuse({ to: 'reviewer' })).toEqual({ ok: false, reason: 'not_granted' });
    expect(refuse({ from: 'reviewer' })).toEqual({ ok: false, reason: 'not_granted' });
    expect(refuse({ action: 'case.close' })).toEqual({ ok: false, reason: 'not_granted' });
    expect(refuse({ argumentsDigest: argumentsDigest({ query: 'other' }) })).toEqual({ ok: false, reason: 'not_granted' });
    expect(refuse({ chainDigest: 'f'.repeat(64) })).toEqual({ ok: false, reason: 'not_granted' });
    expect(refuse({ depth: 2 })).toEqual({ ok: false, reason: 'not_granted' });
    expect(refuse({ kind: 'result' })).toEqual({ ok: false, reason: 'not_granted' });
  });

  it('refuses an envelope that belongs to another execution, tenant or principal', () => {
    const g = granted();
    expect(authoriseEnvelope({ value: envelopeFor(g, { executionId: 'exec-2' }), record: g.rec, state: g.state })).toEqual({ ok: false, reason: 'authority_mismatch' });
    expect(authoriseEnvelope({ value: envelopeFor(g, { tenantId: 'tenant-b' }), record: g.rec, state: g.state })).toEqual({ ok: false, reason: 'authority_mismatch' });
    expect(authoriseEnvelope({ value: envelopeFor(g, { principalRef: 'p-other' }), record: g.rec, state: g.state })).toEqual({ ok: false, reason: 'authority_mismatch' });
  });

  it('refuses a grant whose action needs a scope the destination does not hold', () => {
    const first = hop(initialExecutionState, [], 'triage', 'retrieval', ['read:documents']);
    const issued = issueGrant({
      record, state: first.state, chain: first.chain, kind: 'request', action: 'case.read', argumentsDigest: argumentsDigest({}), requiredScopes: ['read:cases'],
    });
    expect(issued).toEqual({ ok: false, reason: 'scope_escalation' });
  });

  it('refuses to grant on an empty chain, since no hop has been authorised', () => {
    expect(issueGrant({ record, state: initialExecutionState, chain: [], kind: 'request', action: 'x', argumentsDigest: 'd', requiredScopes: [] }))
      .toEqual({ ok: false, reason: 'empty_chain' });
  });

  it('issuing a grant does not count as a delegation', () => {
    const g = granted();
    expect(g.state.delegationsIssued).toBe(1);
    expect(g.state.openGrants).toHaveLength(1);
  });

  it('two identical grants are two distinct permissions, each usable once', () => {
    const g = granted();
    const second = issueGrant({
      record: g.rec, state: g.state, chain: g.chain, kind: 'request', action: 'documents.search',
      argumentsDigest: argumentsDigest({ query: 'refund policy' }), requiredScopes: ['read:documents'],
    });
    if (!second.ok) throw new Error('setup');
    const one = authoriseEnvelope({ value: envelopeFor(g), record: g.rec, state: second.state });
    if (!one.ok) throw new Error('setup');
    expect(authoriseEnvelope({ value: envelopeFor(g), record: g.rec, state: one.state }).ok).toBe(true);
    const spent = authoriseEnvelope({ value: envelopeFor(g), record: g.rec, state: one.state });
    if (!spent.ok) throw new Error('setup');
    expect(authoriseEnvelope({ value: envelopeFor(g), record: g.rec, state: spent.state })).toEqual({ ok: false, reason: 'grant_consumed' });
  });

  it('refuses once the global step budget is spent, even with an open grant', () => {
    const tight: ExecutionRecord = { ...record, limits: { ...record.limits, maxSteps: 1 } };
    const g = granted({ rec: tight });
    const one = authoriseEnvelope({ value: envelopeFor(g), record: tight, state: g.state });
    if (!one.ok) throw new Error('setup');
    const second = issueGrant({
      record: tight, state: one.state, chain: g.chain, kind: 'request', action: 'documents.search',
      argumentsDigest: argumentsDigest({ query: 'refund policy' }), requiredScopes: ['read:documents'],
    });
    if (!second.ok) throw new Error('setup');
    expect(authoriseEnvelope({ value: envelopeFor(g), record: tight, state: second.state })).toEqual({ ok: false, reason: 'step_budget_exceeded' });
  });
});

describe('approval binding', () => {
  const chainA: DelegationChain = [{ from: 'triage', to: 'retrieval', effectiveScopes: ['read:documents'] }];
  const chainB: DelegationChain = [{ from: 'triage', to: 'reviewer', effectiveScopes: ['read:cases'] }];
  const base = { tenantId: 'tenant-a', principalRef: 'p-digest-1', action: 'case.close', argumentsDigest: argumentsDigest({ caseId: 'c1' }) };

  it('is deterministic for equal inputs', () => {
    expect(approvalBindingDigest({ ...base, chain: chainA })).toBe(approvalBindingDigest({ ...base, chain: chainA }));
  });

  it('changes when the delegation chain changes, so an approval cannot move to another delegate', () => {
    expect(approvalBindingDigest({ ...base, chain: chainA })).not.toBe(approvalBindingDigest({ ...base, chain: chainB }));
  });

  it('changes with the tenant, principal, action or arguments', () => {
    const reference = approvalBindingDigest({ ...base, chain: chainA });
    expect(approvalBindingDigest({ ...base, tenantId: 'tenant-b', chain: chainA })).not.toBe(reference);
    expect(approvalBindingDigest({ ...base, principalRef: 'p-other', chain: chainA })).not.toBe(reference);
    expect(approvalBindingDigest({ ...base, action: 'case.reopen', chain: chainA })).not.toBe(reference);
    expect(approvalBindingDigest({ ...base, argumentsDigest: argumentsDigest({ caseId: 'c2' }), chain: chainA })).not.toBe(reference);
  });
});

describe('canonical digests', () => {
  it('does not depend on key order or scope order', () => {
    expect(argumentsDigest({ a: 1, b: { x: 1, y: 2 } })).toBe(argumentsDigest({ b: { y: 2, x: 1 }, a: 1 }));
    const one: DelegationChain = [{ from: 'a', to: 'b', effectiveScopes: ['s2', 's1'] }];
    const two: DelegationChain = [{ from: 'a', to: 'b', effectiveScopes: ['s1', 's2'] }];
    expect(chainDigest(one)).toBe(chainDigest(two));
  });

  it('does not treat array order as irrelevant', () => {
    expect(argumentsDigest({ list: [1, 2] })).not.toBe(argumentsDigest({ list: [2, 1] }));
  });
});

describe('isolation of the C8 design', () => {
  it('imports nothing from execution, MCP, database, gateway or tool code', () => {
    const forbidden = [/from ['"]\.\.\/mcp/, /from ['"]\.\.\/agents\//, /from ['"]\.\.\/security\//, /from ['"]\.\.\/workflow/,
      /from ['"]pg['"]/, /from ['"]@modelcontextprotocol/, /from ['"]\.\.\/storage/, /from ['"]\.\.\/auth/];
    const directory = new URL('.', import.meta.url);
    for (const file of readdirSync(directory).filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))) {
      const source = readFileSync(new URL(file, directory), 'utf8');
      for (const pattern of forbidden) expect(source).not.toMatch(pattern);
    }
  });
});

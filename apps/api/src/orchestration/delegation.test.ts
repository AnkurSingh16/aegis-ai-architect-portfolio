import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  agentsInChain, approvalBindingDigest, argumentsDigest, buildEnvelope, chainDigest, decideDelegation, effectiveScopes,
  extendChain, isSubset, validateEnvelope, withinStepBudget,
} from './delegation.js';
import type { AgentDefinition, DelegationChain, ExecutionRecord } from './types.js';

// Pure, deterministic tests for the C8 design. No database, no MCP, no tool invocation.

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

const decide = (chain: DelegationChain, from: string, to: string, requestedScopes: string[], rec: ExecutionRecord = record) =>
  decideDelegation({ record: rec, chain, agents, from, to, requestedScopes });

describe('non-escalating scopes', () => {
  it('intersects the principal with the root registration, then the delegate registration', () => {
    expect(effectiveScopes(['read:cases', 'read:documents', 'write:cases'], ['read:cases', 'read:documents'])).toEqual(['read:cases', 'read:documents']);
    expect(effectiveScopes(['read:cases'], ['read:documents'])).toEqual([]);
  });

  it('allows a delegate to receive a scope it is registered for and the delegator carries', () => {
    const decision = decide([], 'triage', 'retrieval', ['read:documents']);
    expect(decision).toEqual({ allowed: true, link: { from: 'triage', to: 'retrieval', effectiveScopes: ['read:documents'] } });
  });

  it('refuses a request for a scope the delegate is not registered for', () => {
    expect(decide([], 'triage', 'retrieval', ['read:cases'])).toEqual({ allowed: false, reason: 'scope_escalation' });
  });

  it('refuses a request for a scope the principal does not hold, even if the agent is registered for it', () => {
    expect(decide([], 'triage', 'writer', ['write:cases'])).toEqual({ allowed: false, reason: 'scope_escalation' });
  });

  it('cannot widen along a chain: the second hop is limited by the first hop', () => {
    const first = decide([], 'triage', 'retrieval', ['read:documents']);
    if (!first.allowed) throw new Error('setup');
    const chain = extendChain([], first.link);
    // reviewer is registered for read:cases, but the first hop only carried read:documents.
    expect(decide(chain, 'retrieval', 'reviewer', ['read:cases'])).toEqual({ allowed: false, reason: 'scope_escalation' });
    expect(decide(chain, 'retrieval', 'reviewer', [])).toEqual({ allowed: true, link: { from: 'retrieval', to: 'reviewer', effectiveScopes: [] } });
  });

  it('isSubset is exact and treats an empty request as allowed', () => {
    expect(isSubset(['a'], ['a', 'b'])).toBe(true);
    expect(isSubset(['a', 'c'], ['a', 'b'])).toBe(false);
    expect(isSubset([], [])).toBe(true);
  });
});

describe('global bounds', () => {
  it('refuses a hop beyond the maximum depth', () => {
    const shallow = { ...record, limits: { ...record.limits, maxDepth: 1, maxDelegations: 9 } };
    const first = decide([], 'triage', 'retrieval', ['read:documents'], shallow);
    if (!first.allowed) throw new Error('setup');
    const chain = extendChain([], first.link);
    expect(decide(chain, 'retrieval', 'reviewer', [], shallow)).toEqual({ allowed: false, reason: 'depth_exceeded' });
  });

  it('refuses delegations beyond the execution-wide budget', () => {
    const tight = { ...record, limits: { ...record.limits, maxDepth: 9, maxDelegations: 1 } };
    const first = decide([], 'triage', 'retrieval', ['read:documents'], tight);
    if (!first.allowed) throw new Error('setup');
    const chain = extendChain([], first.link);
    expect(decide(chain, 'retrieval', 'reviewer', [], tight)).toEqual({ allowed: false, reason: 'delegation_budget_exceeded' });
  });

  it('counts steps against the budget deterministically', () => {
    expect(withinStepBudget(9, record.limits)).toBe(true);
    expect(withinStepBudget(10, record.limits)).toBe(false);
  });
});

describe('cycles, self-delegation and continuity', () => {
  it('refuses delegation to the root agent', () => {
    const first = decide([], 'triage', 'retrieval', ['read:documents']);
    if (!first.allowed) throw new Error('setup');
    const chain = extendChain([], first.link);
    expect(decide(chain, 'retrieval', 'triage', ['read:documents'])).toEqual({ allowed: false, reason: 'cycle' });
  });

  it('refuses a repeat of an agent that appears mid-chain', () => {
    const toRetrieval = decide([], 'triage', 'retrieval', ['read:documents']);
    if (!toRetrieval.allowed) throw new Error('setup');
    const chain = extendChain([], toRetrieval.link);
    const toReviewer = decide(chain, 'retrieval', 'reviewer', []);
    if (!toReviewer.allowed) throw new Error('setup');
    const longer = extendChain(chain, toReviewer.link);
    expect(decide(longer, 'reviewer', 'retrieval', [])).toEqual({ allowed: false, reason: 'cycle' });
  });

  it('refuses self-delegation', () => {
    expect(decide([], 'triage', 'triage', [])).toEqual({ allowed: false, reason: 'self_delegation' });
  });

  it('refuses a hop that does not start at the agent currently holding the chain', () => {
    const first = decide([], 'triage', 'retrieval', ['read:documents']);
    if (!first.allowed) throw new Error('setup');
    const chain = extendChain([], first.link);
    expect(decide(chain, 'triage', 'reviewer', [])).toEqual({ allowed: false, reason: 'discontinuous_chain' });
  });

  it('refuses unknown agents on either side', () => {
    expect(decide([], 'triage', 'ghost', [])).toEqual({ allowed: false, reason: 'unknown_agent' });
    expect(decide([], 'ghost', 'retrieval', [])).toEqual({ allowed: false, reason: 'discontinuous_chain' });
  });

  it('lists agents from the root through the chain', () => {
    const chain: DelegationChain = [{ from: 'triage', to: 'retrieval', effectiveScopes: ['read:documents'] }];
    expect(agentsInChain('triage', chain)).toEqual(['triage', 'retrieval']);
  });
});

describe('typed envelopes and tampering', () => {
  const chain: DelegationChain = [{ from: 'triage', to: 'retrieval', effectiveScopes: ['read:documents'] }];
  const argsDigest = argumentsDigest({ query: 'refund policy' });
  const valid = () => buildEnvelope({ kind: 'request', record, chain, from: 'retrieval', to: 'reviewer', action: 'documents.search', argumentsDigest: argsDigest });

  it('accepts an envelope the orchestrator built', () => {
    expect(validateEnvelope({ envelope: valid(), record, chain, stepsTaken: 1 })).toEqual({ ok: true });
  });

  it('refuses any extra field, including authority-shaped fields', () => {
    for (const extra of ['scopes', 'tenantId_override', 'approvalId', 'principal', 'bypass']) {
      expect(validateEnvelope({ envelope: { ...valid(), [extra]: 'x' }, record, chain, stepsTaken: 1 })).toEqual({ ok: false, reason: 'unexpected_fields' });
    }
  });

  it('refuses a missing field', () => {
    const partial: Record<string, unknown> = { ...valid() };
    delete partial.action;
    expect(validateEnvelope({ envelope: partial, record, chain, stepsTaken: 1 })).toEqual({ ok: false, reason: 'unexpected_fields' });
  });

  it('refuses a changed tenant, principal, execution or chain digest', () => {
    for (const change of [{ tenantId: 'tenant-b' }, { principalRef: 'p-other' }, { executionId: 'exec-2' }, { chainDigest: 'f'.repeat(64) }]) {
      expect(validateEnvelope({ envelope: { ...valid(), ...change }, record, chain, stepsTaken: 1 })).toEqual({ ok: false, reason: 'authority_mismatch' });
    }
  });

  it('refuses a depth that does not match the chain it claims', () => {
    expect(validateEnvelope({ envelope: { ...valid(), depth: 0 }, record, chain, stepsTaken: 1 })).toEqual({ ok: false, reason: 'authority_mismatch' });
  });

  it('refuses a sender that does not hold the chain', () => {
    expect(validateEnvelope({ envelope: { ...valid(), from: 'reviewer' }, record, chain, stepsTaken: 1 })).toEqual({ ok: false, reason: 'discontinuous_chain' });
  });

  it('refuses non-string or wrongly typed fields and unknown kinds', () => {
    expect(validateEnvelope({ envelope: { ...valid(), action: 42 }, record, chain, stepsTaken: 1 })).toEqual({ ok: false, reason: 'malformed' });
    expect(validateEnvelope({ envelope: { ...valid(), kind: 'command' }, record, chain, stepsTaken: 1 })).toEqual({ ok: false, reason: 'malformed' });
    expect(validateEnvelope({ envelope: { ...valid(), depth: '1' }, record, chain, stepsTaken: 1 })).toEqual({ ok: false, reason: 'malformed' });
    expect(validateEnvelope({ envelope: null, record, chain, stepsTaken: 1 })).toEqual({ ok: false, reason: 'malformed' });
  });

  it('refuses a step once the global step budget is spent', () => {
    expect(validateEnvelope({ envelope: valid(), record, chain, stepsTaken: 10 })).toEqual({ ok: false, reason: 'step_budget_exceeded' });
  });

  it('keeps arguments out of the envelope: only their digest travels', () => {
    expect(Object.keys(valid())).not.toContain('arguments');
    expect(valid().argumentsDigest).toBe(argsDigest);
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

# C8: Typed multi-agent orchestration (design only)

Status: **MISSING**. This document records a proposed architecture and the deterministic rules implemented as pure functions. It does not enable agent-to-agent execution, register production tools, introduce credentials, or change the identity configuration. Its status changes only with implementation evidence and independent review.

Branch: `c8-design-foundation`, created from `origin/c10-security-hardening` so that it does not carry C6 changes. Its relationship to C6 (PR #76) is independent. The two lines are not combined.

## 1. What is implemented (deterministic, pure)

| Module | Contents | Runtime use |
| --- | --- | --- |
| `apps/api/src/orchestration/types.ts` | Closed agent roles, agent definitions, delegation links, execution record, execution limits, typed envelope | None |
| `apps/api/src/orchestration/delegation.ts` | Non-escalating scope calculation, delegation decision, chain extension, chain digest, arguments digest, approval-binding digest, envelope builder and validator, step budget, canonical JSON | None |
| `apps/api/src/orchestration/delegation.test.ts` | 30 deterministic tests (see section 6) | Test only |

The modules import nothing from MCP, the tool dispatcher, the gateway, the workflow engine, the storage layer, the authentication layer or the `pg` driver. A test enforces this on the source text.

## 2. Architecture

### 2.1 Typed agents

- An agent is a static `AgentDefinition`: an id, a closed role (`triage`, `retrieval`, `reviewer`), and `registeredScopes`.
- Registered scopes are a ceiling fixed at registration. A message cannot raise them.
- A role is a label. It grants nothing by itself. Authority comes only from scopes intersected along the chain.

### 2.2 Execution record

Owned by the orchestrator for one execution: execution id, tenant id, a digest of the authenticated principal (never the raw subject), the principal's verified scopes, the root agent, and the execution limits. Every envelope is checked against this record. Nothing in a message can change it.

### 2.3 Delegation chains and non-escalation

- A chain is an ordered list of links. Each link records `from`, `to` and the effective scopes that hop carries.
- Root effective scopes = principal scopes ∩ root registration.
- Hop effective scopes = previous hop's effective scopes ∩ delegate registration. A hop may request a subset of that. Scopes are never added along a chain.
- `decideDelegation` checks, in fixed order: continuity (the sender holds the chain), known agents, self-delegation, cycles (any agent already in the chain, including the root), depth, delegation budget, and scope subset. The first failure is returned, so refusals are deterministic.

### 2.4 Global execution limits

`maxDepth`, `maxDelegations` (across all branches) and `maxSteps` (tool requests and results) apply to one execution. They are not per loop. The existing per-loop bounds (for example the 1 to 3 rounds in `rag/self-correcting-answer.ts`) are unchanged and remain inside them.

### 2.5 Typed envelopes

An envelope carries exactly ten fields: kind (`request` or `result`), execution id, tenant id, principal digest, `from`, `to`, depth, chain digest, action name, and arguments digest.

- It never carries arguments, scopes, approval references or free-form text. Arguments travel only as a digest.
- `validateEnvelope` refuses extra fields (so authority-shaped fields cannot be smuggled), wrongly typed fields, a sender that does not hold the chain, any mismatch of execution, tenant, principal, depth or chain digest against the orchestrator's record, and any step beyond the budget.
- Envelopes are built only by the orchestrator (`buildEnvelope`). No code path copies authority from message content.

### 2.6 Cycle detection

Cycles are detected from the chain itself: a `to` that already appears in the root-plus-chain sequence is refused, and so is self-delegation. Depth and budget bounds cap the cost of any cycle the check misses.

### 2.7 Approval binding

An approval for a delegated action must bind to the whole context, so that it cannot be moved to another delegate, another principal, another tenant or other arguments. The binding digest covers tenant, principal digest, chain digest, action name and arguments digest (`approvalBindingDigest`). Changing any one of them changes the digest. The existing gateway approval store (single use, tenant-scoped, digest-bound) remains the enforcement point; C8 would supply the digest, not a new approval mechanism.

### 2.8 Audit events (designed, not wired)

Each delegation decision and each envelope validation should produce one structured event with: execution id, tenant id, principal digest, hop number, `from`, `to`, decision (allowed or refused reason), chain digest, and the step count. Message content and arguments are never recorded, consistent with the MCP audit rules. Wiring to the audit sink is future work.

### 2.9 Identity of agents

Agent identity is a configuration value in this design, as it is in the existing gateway. The design does not authenticate agents per call. That is a decision for the owner (section 5).

## 3. Explicitly not implemented

- No execution of any agent, and no agent-to-agent message transport or queue.
- No persistence, no database tables, no migrations.
- No production tool registration and no new production tool.
- No new credentials, no identity-provider change, no per-agent token.
- No link to MCP, the gateway, the dispatcher or the workflow engine.
- No change to the live identity configuration or to any route.

## 4. Remaining risks to resolve before activation

1. Per-agent authentication does not exist. Without it, an agent id is a claim, and the non-escalation rule protects scopes only if the orchestrator, not an agent, assigns the ids.
2. Confused deputy: an agent acting for another must carry the originating principal from the verified context. The design requires this, but the runtime path does not exist yet.
3. Message content from models must never reach envelope fields that control authority. The design enforces this by field set, which must be preserved by every future change.
4. Budgets are execution-scoped. Concurrency across executions, and the cost of many executions, are not bounded by this design.
5. The approval store does not yet accept a delegation digest. Adding it changes a security-critical table and needs review.
6. Audit events are designed but not emitted.
7. No independent review of this design has happened.

## 5. Decisions needed before any activation

1. **Agent identity.** Will each agent have its own authenticated credential (an identity-provider change, which needs separate approval), or will the orchestrator alone assign agent ids? This decides how much the non-escalation rule can be trusted.
2. **Role set.** Are `triage`, `retrieval` and `reviewer` the right first roles, or does the owner want a different closed set?
3. **Limits.** Values for `maxDepth`, `maxDelegations` and `maxSteps`. The defaults in the tests (3, 3, 10) are illustrative, not calibrated.
4. **First use case.** Which multi-agent action, if any, is the first candidate, and what approval does a side-effecting step need?
5. **Approval digest.** Should the approval store accept the delegation binding digest, and is that change in scope for C8 or for a separate C10 follow-up?
6. **Independent review.** Who will review C6 and this design, and when? C8 should not be activated before that review.

## 6. Deterministic test evidence

`apps/api/src/orchestration/delegation.test.ts`, 30 tests, all passing, run with `npx vitest run src/orchestration` in `apps/api`. They cover:

- non-escalation: scope intersection, refused escalation from the principal and from the delegate's registration, no widening along a chain, exact subset rule;
- global bounds: depth, delegation budget, step budget;
- cycles, self-delegation, continuity, unknown agents;
- envelopes: acceptance, extra and missing fields, authority-field tampering, depth mismatch, a sender not holding the chain, wrong types, unknown kinds, step budget, absence of arguments;
- approval binding: determinism, and change with chain, tenant, principal, action or arguments;
- canonical digests: key-order and scope-order independence, array order significance;
- isolation: no import of execution, MCP, storage, authentication, gateway or database code.

Typecheck and lint are clean for the worktree.

## 7. Evidence that would justify a status change

- C8 to PARTIAL: an approved implementation of agent registration, delegation through the gateway, and envelope transport, with integration tests against a real database, and an audit trail, reviewed independently.
- C8 to COMPLETE: production use with a bounded first action, the agent-identity decision implemented, and an independent security review with no open high findings.

No such evidence exists yet.

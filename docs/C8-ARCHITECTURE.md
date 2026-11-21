# C8: Typed multi-agent orchestration (design only)

Status: **MISSING**. This document records a proposed architecture and the deterministic rules implemented as pure functions. It does not enable agent-to-agent execution, message transport, production tool registration, new credentials, or changes to the identity configuration. C8 stays MISSING in the requirements register until there is implementation evidence and independent review.

Branch: `c8-design-foundation`, based on `origin/c10-security-hardening`. It does not contain C6 changes, and it does not combine with the C9, C1 or C2 lines. Draft PR: see the pull request for this branch.

## 1. What is implemented (pure, deterministic)

| Module | Contents | Runtime use |
| --- | --- | --- |
| `apps/api/src/orchestration/types.ts` | Closed roles, agent definitions, delegation links, execution record and limits, execution state, grants, typed envelope | None |
| `apps/api/src/orchestration/delegation.ts` | Delegation decision, global budget accounting, grant issuance, structure check, authorisation, digests, canonical JSON | None |
| `apps/api/src/orchestration/delegation.test.ts` | 33 deterministic tests (section 7) | Test only |

The modules import nothing from MCP, the tool dispatcher, the gateway, the workflow engine, the storage layer, the authentication layer or the `pg` driver. A test enforces this on the source text. There is no I/O, no clock and no randomness: grant identifiers are digests of their contents and a sequence number.

## 2. Architecture

### 2.1 Typed agents

- An agent is a static `AgentDefinition`: an id, a closed role (`triage`, `retrieval`, `reviewer`), and `registeredScopes`.
- Registered scopes are a ceiling fixed at registration. No message can raise them.
- A role is a label. It grants nothing by itself. Authority comes only from scopes intersected along the chain.

### 2.2 Execution record and execution state

- **Execution record** (owned by the orchestrator): execution id, tenant id, principal digest (never the raw subject), the principal's verified scopes, the root agent, and the limits. Every envelope is checked against it.
- **Execution state** (threaded through every decision): `delegationsIssued`, `stepsTaken`, open grants and consumed grants. It is the only place the global counters live. Every decision returns a new state; none mutates one.

Callers must thread the state. A sibling branch starts from the same state, not from the initial state, so it cannot reset the budget. A test documents what discarding the state would allow.

### 2.3 Delegation chains and non-escalation

- A chain is an ordered list of links. Each link records `from`, `to` and the effective scopes that hop carries. Each branch of a delegation tree has its own chain. The tree as a whole shares one execution state.
- Root effective scopes = principal scopes ∩ root registration.
- Hop effective scopes = the holder's effective scopes ∩ the delegate's registration. A request may ask only for a subset. Scopes never widen along a chain.
- `decideDelegation` checks, in a fixed order, and returns the first failure:
  1. continuity: the requester holds the branch (`discontinuous_chain`);
  2. both agents are registered (`unknown_agent`);
  3. not self-delegation (`self_delegation`);
  4. no cycle on this branch (`cycle`);
  5. depth of this branch (`depth_exceeded`);
  6. **global delegation budget** in the execution state (`delegation_budget_exceeded`);
  7. requested scopes are a subset of what the delegate can carry (`scope_escalation`).

### 2.4 Global execution limits (corrected)

The earlier version checked the length of one chain against `maxDelegations`. That allowed a fresh chain to reset the count, so a tree with many short branches could exceed the intended bound. The corrected design:

- `maxDelegations` counts every delegation in the execution, across all branches, and lives in `ExecutionState.delegationsIssued`.
- `maxDepth` counts hops on one branch, from the root.
- `maxSteps` counts accepted envelopes in the execution.

Tests show sibling branches sharing the budget, a deeper branch followed by another branch sharing it, and the refusal that follows when the budget is spent even though each new chain is short.

### 2.5 Cycle detection

- A cycle is a delegation to an agent that already appears on the same branch, including the root. Self-delegation is a separate, earlier refusal.
- The same agent may appear on two sibling branches. That is not a cycle, and it is bounded by the global budget and depth.
- A tree cannot create a cycle without repeating an agent on one branch, so the per-branch check is sufficient for cycles. Cost across branches is bounded by the global budget, not by the cycle check.

### 2.6 Structure is not authorisation (corrected)

The earlier version used one validator for two questions. It is now split into two functions with different guarantees.

**`checkEnvelopeStructure`: structure only.** It answers "is this value well formed?" It checks exactly the ten envelope fields, their types, and the kind. It makes no claim about who sent it, where it is going, what it asks, or whether it is allowed. A structurally valid envelope must never be acted on.

**`authoriseEnvelope`: authorisation.** It answers "did the orchestrator grant this exact message, and has that grant not been used?" In order:

1. structure (refused as malformed or unexpected fields);
2. execution, tenant and principal match the record (`authority_mismatch`);
3. the global step budget is not spent (`step_budget_exceeded`);
4. an **open grant** matches every field: kind, execution, tenant, principal, chain digest, depth, sender, destination, action and arguments digest. No match gives `not_granted`. A match among consumed grants gives `grant_consumed`, so replay is distinguished from an unknown message.

On success the grant moves from open to consumed and the step is counted. Authorisation is single use.

### 2.7 Grants

A grant is the orchestrator's authorisation of one concrete action. It is issued by `issueGrant` only for a chain the orchestrator has already extended. It binds the sender (the holder before the last hop), the destination (the holder after it), the action, the arguments digest, the chain digest, the depth, the principal, the tenant and the execution. It is refused unless the destination's effective scopes cover the action's required scopes.

- Grant identifiers are digests of the grant body and a sequence number. Two otherwise identical grants are two permissions, each usable once.
- Issuing a grant does not count as a delegation.
- A message cannot create a grant, and no field in an envelope can name one. An envelope is authorised by matching a grant, never by its own content.

### 2.8 Envelope meaning

An envelope carries: kind (`request` or `result`), execution id, tenant id, principal digest, `from` (the sender, which holds the branch before the hop), `to` (the destination the grant names), depth, chain digest, action name, and arguments digest. It never carries arguments, scopes, approval references or free-form text. Arguments travel only as a digest.

### 2.9 Approval binding

An approval for a delegated action should bind to everything that makes the action what it is: tenant, principal digest, chain digest, action name and arguments digest (`approvalBindingDigest`). Changing any one changes the digest, so an approval cannot move to another delegate or another action. The existing gateway approval store (single use, tenant-scoped, digest-bound) remains the enforcement point. C8 supplies the digest; it does not add a new approval mechanism. See decision 4 in section 6.

### 2.10 Audit events (designed, not wired)

Each delegation decision, grant issuance and authorisation should produce one structured event with: execution id, tenant id, principal digest, hop number, sender, destination, decision or refusal reason, chain digest, and the step count. Message content and arguments are never recorded, consistent with the MCP audit rules. Wiring is future work.

### 2.11 Agent identity

Agent identity is a configuration value in this design, as in the existing gateway. The design does not authenticate agents per call. This is decision 1 in section 6.

## 3. Initial proposals for review

| Area | Proposal | Why |
| --- | --- | --- |
| Roles | `triage`, `retrieval`, `reviewer`. No role is granted a write scope in this design | Smallest set that exercises delegation. Writing needs approval design first |
| Non-escalation | Intersection along the chain only | Scopes can only narrow |
| Global budget | One execution-wide counter for delegations, one for steps | Prevents reset by branching |
| Depth | Per branch | Bounds nesting cost on a path |
| Cycles | Per branch, plus self-delegation refusal | Sibling reuse is legitimate |
| Grants | Single use, bound to sender, destination, action, arguments and chain | Structure cannot authorise |
| Results | Same grant machinery, `kind: 'result'` | One mechanism to review |

## 4. Explicitly not implemented

- No execution of any agent, and no agent-to-agent message transport or queue.
- No persistence and no database tables or migrations. State is an in-memory value.
- No production tool registration and no new production tool.
- No new credentials, no identity-provider change, no per-agent token.
- No link to MCP, the gateway, the dispatcher or the workflow engine.
- No change to the live identity configuration or to any route.
- No clock: grants have no expiry in this design (decision 7).
- No concurrency control: the state is a pure value. A runtime would need a single writer per execution (decision 9).

## 5. Remaining risks before any activation

1. Agent identity is a claim without per-agent authentication. The non-escalation rule protects scopes only if the orchestrator, not an agent, assigns ids.
2. Confused deputy: a runtime must take the originating principal from the verified context. The design requires it; no runtime path exists.
3. Model-generated content must never reach envelope fields that control authority. The design enforces this by field set; every future change must keep it.
4. Grants do not expire. A grant issued and never used stays open for the life of the state.
5. The approval store does not accept a delegation digest yet.
6. Audit events are designed but not emitted.
7. No independent review of this design has happened.

## 6. Decisions that need your approval

1. **Agent identity (blocking).** Will each agent have its own authenticated credential (an identity-provider change, needing separate approval), or will the orchestrator alone assign agent ids? This decides how far the non-escalation rule can be trusted. My recommendation: decide this before any runtime work.
2. **Role set.** Are `triage`, `retrieval` and `reviewer` the right first roles, and should any role ever hold a write scope? I recommend no write role until the approval binding is wired.
3. **Limits.** Values for `maxDepth`, `maxDelegations` and `maxSteps`. The test values (3, 3, 10) are illustrative, not calibrated.
4. **Approval binding granularity.** Two identical grants produce one approval digest, so one approval record could authorise either. Should the binding include the grant identifier, which makes each approval specific to one grant? I recommend including it.
5. **Approval store integration.** Should the approval store accept the binding digest? This changes a security-critical table, so it belongs in a separate C10 follow-up with its own review.
6. **Repetition across sibling branches.** I propose allowing the same agent on sibling branches, bounded by the global budget. The alternative is a stricter per-execution rule that refuses any repeated agent, which is simpler but blocks legitimate fan-out.
7. **Grant expiry.** Grants currently have no expiry. Options: expire with the execution, or a time bound from the orchestrator's clock. I recommend tying grants to the execution and adding a time bound when a runtime exists.
8. **Results.** Should results need their own grant, or may they flow back on the request grant? I recommend their own grant, using the same mechanism.
9. **Concurrency.** The state is a single value. Before a runtime, we need a decision on how executions serialise state changes: a single writer per execution, or a database transaction per decision.
10. **First use case.** Which multi-agent action, if any, comes first, and what approval does a side-effecting step need?

## 7. Deterministic test evidence

`apps/api/src/orchestration/delegation.test.ts`, 33 tests, all passing, run with `npx vitest run src/orchestration` in `apps/api`. They cover:

- **Non-escalation:** scope intersection; refusal from the principal and from the delegate's registration; no widening along a chain; exact subset rule.
- **Global budget across branches:** sibling branches share one count; a deeper branch followed by another branch shares it; the refusal when the budget is spent; the failure mode of discarding state.
- **Per-branch depth and cycles:** depth refusal independent of the global budget; delegation back to the root; repetition mid-chain; the same agent on sibling branches is allowed; self-delegation, discontinuous hops, unknown agents.
- **Structure is not authorisation:** structure accepts a well-formed message with no authority claim; extra, missing and wrongly typed fields and unknown kinds are refused; a structurally valid but ungranted envelope is refused as `not_granted`.
- **Grants:** an authorised message is accepted once and counted; replay is refused as `grant_consumed`; a different destination, sender, action, arguments, chain, depth or kind is refused as `not_granted`; another execution, tenant or principal gives `authority_mismatch`; a grant whose action needs an unheld scope is refused; an empty chain cannot be granted; issuing a grant does not count as a delegation; identical grants are distinct and each usable once; the step budget refuses once spent.
- **Approval binding:** deterministic; changes with the chain, tenant, principal, action or arguments.
- **Canonical digests:** key and scope order independence; array order significance.
- **Isolation:** no import of execution, MCP, storage, authentication, gateway, workflow or database code.

Typecheck and lint are clean for the branch. The full API unit suite is recorded in the pull request.

## 8. Evidence that would justify a status change

- **MISSING to PARTIAL:** an approved implementation of agent registration, delegation through the gateway, grant-backed envelope transport, and audit events, with integration tests against a real database, reviewed independently.
- **PARTIAL to COMPLETE:** production use with a bounded first action, the agent-identity decision implemented, and an independent security review with no open high findings.

No such evidence exists yet.

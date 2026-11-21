# C8 assessment: typed multi-agent orchestration

Status: **MISSING**. This is an evidence-based assessment, not an implementation. No multi-agent action is enabled, and no orchestration code was added.

## What exists (evidence)

| Building block | Where | What it gives C8 | Limit for C8 |
| --- | --- | --- | --- |
| Gateway with several registered agents | `security/tool-policy-gateway.ts` (`AgentRegistration`, `agents` map) | Per-agent scopes; effective scope is the intersection of agent and user scopes | `agentId` is a configuration value passed in by the caller, not an authenticated per-call identity. Nothing records which agent asked another agent to act |
| Default agent registry | `agents/default-tools.ts` (`triage-agent`, scope `read:cases`) | One agent, one read-only tool | No second agent, no delegation |
| MCP agent | `mcp/server.ts` (`mcp-agent`) | One agent for one server process | Same as above |
| Bounded loops | `rag/self-correcting-answer.ts` (1 to 3 rounds), `workflow/durable-driver.ts` (attempts, leases, retry policy) | Proven bounded iteration for one agent | No bound spans several agents, and no depth or fan-out limit exists |
| Durable state machine | `workflow/durable-store.ts`, `durable-driver.ts`, migration 008 | Checkpoints, leases, approval gates per attempt, cancellation with an actor and reason | Built for one workflow execution, not for messages between agents |
| Approval store | `security/tool-approval-store.ts`, migration 007 | Single-use, tenant-scoped, digest-bound approvals | Approvals bind an action, not a delegation chain |
| Test-only synthetic side effect | `agents/synthetic-side-effect.integration.test.ts` | Shows the approval boundary holds for one agent | Not multi-agent |

Searches of non-test source for `orchestrat`, `delegat`, `multi-agent` and messaging terms found no orchestration implementation. The only hits are unrelated (a comment in the gateway and an evaluation script).

## What C8 needs, and the gap

| Requirement (register) | Status | Gap |
| --- | --- | --- |
| Typed roles | Missing | No role model. Agents have scopes only |
| Typed messages | Missing | No message schema or envelope |
| Delegation | Missing | No delegation record. A delegate could be given more authority than its delegator unless a non-escalation rule exists |
| Bounded loops across agents | Missing | Per-loop bounds exist. No global depth, fan-out or total-step bound |
| Approval integration | Partial | Approvals exist for one action. An approval for a delegated action would need the delegation chain in its digest |
| Agent identity | Missing | `agentId` is trusted from configuration. Per-agent authentication does not exist |

## Security risks to resolve before enabling anything

1. **Privilege escalation through delegation.** Without a non-escalation rule, agent A could delegate to agent B and gain B's scopes. The rule must be: a delegate's effective scope is at most the delegator's effective scope, intersected with the delegate's registration.
2. **Confused deputy.** An agent acting on another's instruction must carry the originating principal and tenant. Both must come from the verified context, never from a message body.
3. **Unbounded fan-out and recursion.** Needs a hard maximum depth, a maximum number of delegations per execution, and a cycle check.
4. **Message injection.** Message content from one agent (possibly model output) must not carry scopes, tenant, approval references or agent identity. The envelope must be built by the orchestrator, not copied from content.
5. **Approval scope.** An approval granted to a human for one action must not be reusable for a delegated action with different arguments or a different delegate. The digest must include the delegation chain.
6. **Audit.** Every delegation and message needs a structured event with the chain of agent identities, and must not record message content.

## Recommendation

Do not start C8 production work yet. Two sequenced steps, both needing approval:

1. **Independent review of C6 first** (see [C6-SECURITY-REVIEW-PACKAGE.md](C6-SECURITY-REVIEW-PACKAGE.md)). C8 would reuse the gateway, approval and audit controls that the review is examining.
2. **Design-only spike for C8, then a deterministic foundation.** Write the delegation and message model as types and pure functions with tests: a typed envelope built only by the orchestrator, a non-escalating scope calculation, depth and fan-out bounds, and a cycle check. No agent-to-agent execution and no side effects. Keep C8 MISSING in the register until the spike is reviewed.

Decisions needed from the owner before step 2: whether agent identity will be authenticated per agent (a separate credential per agent, which is an identity-provider change), and which multi-agent action, if any, is the first candidate for a production use case.

## Evidence references

- Gateway agent scopes and approvals: `apps/api/src/security/tool-policy-gateway.ts`
- Default agent registry: `apps/api/src/agents/default-tools.ts`
- Bounded loop: `apps/api/src/rag/self-correcting-answer.ts`
- Durable driver: `apps/api/src/workflow/durable-driver.ts`
- Approval store: `apps/api/src/security/tool-approval-store.ts`
- Register row: `docs/ENTERPRISE-REQUIREMENTS-REGISTER.md`, row C8

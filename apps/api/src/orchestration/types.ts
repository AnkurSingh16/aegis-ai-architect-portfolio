/**
 * C8 design, pure types. Nothing in this directory performs execution, reads a database, calls a tool or connects to MCP.
 * The types describe how delegation would be represented and checked. They do not enable agent-to-agent action.
 */

/** Closed set of agent roles. A role is a design label; it grants nothing by itself. Authority comes from registered scopes. */
// P4 port: 'orchestrator' is added as the root role. It is the only role that may hold an execution lease.
export const AGENT_ROLES = ['orchestrator', 'triage', 'retrieval', 'reviewer'] as const;
export type AgentRole = (typeof AGENT_ROLES)[number];

/** A statically registered agent. Its scopes are a ceiling, fixed at registration, never raised by a message. */
export interface AgentDefinition {
  readonly id: string;
  readonly role: AgentRole;
  readonly registeredScopes: readonly string[];
}

/** One hop of a delegation. Recorded by the orchestrator, never copied from message content. */
export interface DelegationLink {
  readonly from: string;
  readonly to: string;
  /** The scopes this hop carries: the delegator's effective scopes intersected with the delegate's registration. */
  readonly effectiveScopes: readonly string[];
}

/** The hops from the root to the agent that currently holds the branch. Each branch of a tree has its own chain. */
export type DelegationChain = readonly DelegationLink[];

/** Global bounds for one execution. They apply across all branches and all agents, not per chain or per loop. */
export interface ExecutionLimits {
  /** Maximum number of hops on any one branch, from the root. */
  readonly maxDepth: number;
  /** Maximum number of delegations issued in the whole execution, across every branch. */
  readonly maxDelegations: number;
  /** Maximum number of accepted envelopes in the whole execution. */
  readonly maxSteps: number;
}

/** Facts the orchestrator owns for one execution. Every envelope is checked against this record. */
export interface ExecutionRecord {
  readonly executionId: string;
  readonly tenantId: string;
  /** A digest of the authenticated principal. Never the raw subject. */
  readonly principalRef: string;
  /** Scopes of the verified principal. Delegation can only narrow them. */
  readonly principalScopes: readonly string[];
  readonly rootAgent: string;
  readonly limits: ExecutionLimits;
}

/**
 * Mutable-looking but immutable value that carries the global counters and the grants for one execution. It is the only place the
 * budgets live. A new branch starts from the same state, so it cannot reset a budget.
 */
export interface ExecutionState {
  readonly delegationsIssued: number;
  readonly stepsTaken: number;
  /** Grants issued by the orchestrator and not yet consumed. */
  readonly openGrants: readonly Grant[];
  /** Grants that were consumed. Kept whole, so a replayed envelope is recognised and refused as a replay. */
  readonly consumedGrants: readonly Grant[];
}

/**
 * The orchestrator's authorisation of one concrete action: this destination, this action, these argument digests, on this chain, for
 * this principal and tenant. Only a grant authorises an envelope. A message can never create one.
 */
export interface Grant {
  readonly grantId: string;
  readonly kind: 'request' | 'result';
  readonly executionId: string;
  readonly tenantId: string;
  readonly principalRef: string;
  readonly chainDigest: string;
  readonly depth: number;
  readonly from: string;
  readonly to: string;
  readonly action: string;
  readonly argumentsDigest: string;
  /** The scopes the action needs. Checked against the destination's effective scopes when the grant is issued. */
  readonly requiredScopes: readonly string[];
}

/** The only fields an envelope may carry. Authority is never a field here. */
export interface TypedEnvelope {
  readonly kind: 'request' | 'result';
  readonly executionId: string;
  readonly tenantId: string;
  readonly principalRef: string;
  readonly from: string;
  readonly to: string;
  readonly depth: number;
  readonly chainDigest: string;
  readonly action: string;
  /** Digest of the action arguments. The arguments themselves never travel in an envelope. */
  readonly argumentsDigest: string;
}

export const initialExecutionState: ExecutionState = {
  delegationsIssued: 0,
  stepsTaken: 0,
  openGrants: [],
  consumedGrants: [],
};

/**
 * C8 design, pure types. Nothing in this directory performs execution, reads a database, calls a tool or connects to MCP.
 * The types describe how delegation would be represented and checked. They do not enable agent-to-agent action.
 */

/** Closed set of agent roles. A role is a design label; it grants nothing by itself. Authority comes from registered scopes. */
export const AGENT_ROLES = ['triage', 'retrieval', 'reviewer'] as const;
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

export type DelegationChain = readonly DelegationLink[];

/** Global bounds for one execution. They apply across all agents, not per loop. */
export interface ExecutionLimits {
  /** Maximum number of hops from the root agent. */
  readonly maxDepth: number;
  /** Maximum number of delegations in one execution, across all branches. */
  readonly maxDelegations: number;
  /** Maximum number of steps (tool requests or results) in one execution. */
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

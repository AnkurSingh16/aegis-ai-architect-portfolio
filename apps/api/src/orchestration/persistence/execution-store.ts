import type { TenantQueryable, TenantRunner } from '../../security/tool-approval-store.js';
import { authoriseEnvelope, checkEnvelopeStructure, chainDigest, decideDelegation, extendChain, issueGrant, recordDelegation,
  holderOf } from '../delegation.js';
import type { AgentDefinition, DelegationChain, DelegationLink, ExecutionRecord, ExecutionState, Grant } from '../types.js';

/**
 * P4: PostgreSQL persistence of the C8 execution model.
 *
 * Concurrency model (see docs/P4-AGENT-EXECUTION-STATE.md, section 3):
 * - Every decision runs in one READ COMMITTED transaction that first takes `SELECT ... FOR UPDATE` on the execution row. All writes for
 *   one execution are therefore serialised by that row lock. Other executions are not blocked.
 * - The lock is re-read after it is acquired, so the decision always sees the latest committed counters, grants and lease.
 * - The fencing check is part of the locked read: a worker whose lease expired, or whose fencing token is no longer current, is refused
 *   and that refusal is audited in a transaction that changes no state.
 * - The pure C8 rules (`delegation.ts`) decide. The database then persists exactly the decision it returned, with conditional updates
 *   and constraints as a second line of defence.
 * - Time comes from `clock_timestamp()` on the database. Worker clocks are not used for leases or grant expiry.
 *
 * A decision is either committed completely (state change and audit event together) or not at all. A refusal changes no state and is
 * still audited. Deadlock: each transaction locks the execution row first and never holds a lock on a second execution row, so no
 * cycle between executions can form.
 */

export type ClaimRefusal = 'not_registered' | 'not_orchestrator' | 'not_found' | 'lease_held' | 'terminal' | 'retries_exhausted'
  | 'cancel_requested';

/** Identity of the worker that holds the lease for one execution. The agent id is resolved from the SPIFFE ID, never supplied directly. */
export interface Fence {
  readonly tenantId: string;
  readonly executionId: string;
  readonly agentId: string;
  readonly instance: string;
  readonly fencingToken: number;
}

export type Result<T, R extends string> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly reason: R };

export type FenceRefusal = 'stale_fence' | 'not_found';
export type WriteRefusal = FenceRefusal | string;

export interface ExecutionDecision {
  readonly operation: 'create' | 'claim' | 'renew' | 'release' | 'delegate' | 'grant' | 'consume' | 'cancel';
  readonly executionId: string | null;
  readonly outcome: 'accepted' | 'refused' | 'error';
  readonly reason: string | null;
  readonly durationMs: number;
  /** A claim that took over an execution from a worker whose lease had expired. */
  readonly recovered: boolean;
  /** The execution reached a terminal state with this decision. */
  readonly terminal: boolean;
  /** The execution was started by this decision (its first accepted claim). */
  readonly started: boolean;
}

export interface ExecutionHooks {
  /** Test seam. Runs inside the transaction after every write and before COMMIT. Production passes none. */
  readonly beforeCommit?: (label: string) => Promise<void>;
  /** Telemetry. Called once per public decision, after it has returned or been refused. Must not throw. */
  readonly onDecision?: (decision: ExecutionDecision) => void;
}

export interface NewExecution {
  readonly tenantId: string;
  readonly idempotencyKey: string;
  /** A digest of the authenticated principal. The raw subject never reaches this layer. */
  readonly principalRef: string;
  /** Scopes of the verified principal, taken from the authentication layer by the caller. Never from message content. */
  readonly principalScopes: readonly string[];
  readonly limits: { readonly maxDepth: number; readonly maxDelegations: number; readonly maxSteps: number };
  readonly grantTtlSeconds: number;
  readonly maxAttempts: number;
}

export interface ExecutionSnapshot {
  readonly executionId: string;
  readonly status: string;
  readonly fencingToken: number;
  readonly attempts: number;
  readonly maxAttempts: number;
  readonly delegationsIssued: number;
  readonly maxDelegations: number;
  readonly stepsTaken: number;
  readonly maxSteps: number;
  readonly leaseAgentId: string | null;
  readonly cancelRequested: boolean;
  readonly principalRef: string;
  readonly principalScopes: readonly string[];
}

export interface AuditRow {
  readonly eventType: string;
  readonly outcome: 'accepted' | 'refused';
  readonly reason: string | null;
  readonly actorAgent: string | null;
  readonly actorInstance: string | null;
  readonly fencingToken: number | null;
  readonly delegationSeq: number | null;
  readonly grantId: string | null;
}

export interface AgentExecutionStore {
  createExecution(input: NewExecution): Promise<{ executionId: string; created: boolean }>;
  claim(input: { tenantId: string; executionId: string; spiffeId: string; instance: string; leaseSeconds: number }):
    Promise<Result<{ fencingToken: number; attempts: number; recovered: boolean; agentId: string }, ClaimRefusal>>;
  renew(fence: Fence, leaseSeconds: number): Promise<Result<{ leaseSeconds: number }, WriteRefusal>>;
  release(fence: Fence, nextStatus: 'pending' | 'failed' | 'succeeded' | 'cancelled', reason: string): Promise<Result<{ status: string }, WriteRefusal>>;
  recordDelegation(fence: Fence, input: { parentSeq: number | null; to: string; requestedScopes: readonly string[] }):
    Promise<Result<{ seq: number; depth: number }, WriteRefusal>>;
  issueGrant(fence: Fence, input: { chainSeq: number; kind: 'request' | 'result'; action: string; argumentsDigest: string;
    requiredScopes: readonly string[]; direction?: 'forward' | 'return' }): Promise<Result<{ grantId: string }, WriteRefusal>>;
  consumeEnvelope(fence: Fence, envelope: unknown): Promise<Result<{ grantId: string; stepsTaken: number }, WriteRefusal>>;
  /**
   * P5: a recipient consumes the grant for a message it received. No lease is involved: the recipient is not the lease holder. The
   * envelope must be addressed to `recipient` and sent by `sender` (both verified by the caller), and it must match an open grant
   * exactly. A result envelope addressed to the root agent also finalises the execution (succeeded), under the same lock.
   */
  receiveEnvelope(input: { tenantId: string; executionId: string; recipient: string; sender: string; envelope: unknown }):
    Promise<Result<{ grantId: string }, string>>;
  requestCancel(tenantId: string, executionId: string, actorDigest: string, reason: string):
    Promise<Result<{ state: 'cancelled' | 'cancel_requested' }, 'not_found' | 'terminal'>>;
  snapshot(tenantId: string, executionId: string): Promise<ExecutionSnapshot | null>;
  delegations(tenantId: string, executionId: string): Promise<Array<{ seq: number; parentSeq: number | null; depth: number;
    from: string; to: string; chainDigest: string }>>;
  grants(tenantId: string, executionId: string): Promise<Array<{ grantId: string; status: string; kind: string; to: string;
    action: string; consumedBy: string | null; consumedByFencingToken: number | null }>>;
  events(tenantId: string, executionId: string): Promise<AuditRow[]>;
}

interface ExecRow extends Record<string, unknown> {
  execution_id: string; tenant_id: string; principal_ref: string; principal_scopes: string[]; root_agent: string; status: string;
  max_depth: number; max_delegations: number; max_steps: number; delegations_issued: number; steps_taken: number;
  grant_ttl_seconds: number; attempts: number; max_attempts: number; fencing_token: string; lease_agent_id: string | null;
  lease_instance: string | null; cancel_requested: boolean; cancel_reason: string | null; lease_live: boolean; db_now: Date;
}

interface DelegationDbRow extends Record<string, unknown> {
  seq: number; parent_seq: number | null; depth: number; from_agent: string; to_agent: string; effective_scopes: string[];
  chain_digest: string;
}

interface GrantDbRow extends Record<string, unknown> {
  grant_id: string; kind: 'request' | 'result'; chain_digest: string; depth: number; from_agent: string; to_agent: string;
  action: string; arguments_digest: string; required_scopes: string[]; status: string; expires_at: Date;
  consumed_by_agent: string | null; consumed_by_fencing_token: string | null;
}

const EXEC_COLUMNS = `e.execution_id, e.tenant_id, e.principal_ref, e.principal_scopes, e.root_agent, e.status, e.max_depth,
  e.max_delegations, e.max_steps, e.delegations_issued, e.steps_taken, e.grant_ttl_seconds, e.attempts, e.max_attempts,
  e.fencing_token::text AS fencing_token, e.lease_agent_id, e.lease_instance, e.cancel_requested, e.cancel_reason,
  (e.lease_expires_at > clock_timestamp()) AS lease_live, clock_timestamp() AS db_now`;

const TERMINAL = ['succeeded', 'failed', 'cancelled'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const assertUuid = (value: string, label: string): void => {
  if (!UUID.test(value)) throw new RangeError(`${label} must be a UUID`);
};

/**
 * P5: runs store operations inside a transaction the caller already owns. A message produced by a P4 decision is inserted by the caller
 * in that same transaction, so the decision and its message commit or roll back together. The bound tenant must match.
 */
export function joinTransaction(client: TenantQueryable, tenantId: string): TenantRunner {
  return async <T>(requested: string, operation: (queryable: TenantQueryable) => Promise<T>): Promise<T> => {
    if (requested !== tenantId) throw new Error('joined transaction is bound to another tenant');
    return operation(client);
  };
}

export function createAgentExecutionStore(runTenant: TenantRunner, hooks: ExecutionHooks = {}): AgentExecutionStore {
  const built = buildStore(runTenant, hooks);
  return {
    createExecution: built.createExecution,
    claim: observed('claim', hooks, built.claim, (r) => ({ started: r.ok && !r.value.recovered && r.value.attempts === 1,
      terminal: !r.ok && (r.reason === 'retries_exhausted' || r.reason === 'cancel_requested'), recovered: r.ok && r.value.recovered, reason: r.ok ? null : r.reason, executionId: null })),
    renew: observed('renew', hooks, built.renew, () => ({ started: false, terminal: false, recovered: false, reason: null, executionId: null })),
    release: observed('release', hooks, built.release, (r, args) => ({ started: false, terminal: r.ok && TERMINAL.includes(args[1]), recovered: false, reason: null, executionId: null })),
    recordDelegation: observed('delegate', hooks, built.recordDelegation, () => ({ started: false, terminal: false, recovered: false, reason: null, executionId: null })),
    issueGrant: observed('grant', hooks, built.issueGrant, () => ({ started: false, terminal: false, recovered: false, reason: null, executionId: null })),
    consumeEnvelope: observed('consume', hooks, built.consumeEnvelope, () => ({ started: false, terminal: false, recovered: false, reason: null, executionId: null })),
    receiveEnvelope: observed('consume', hooks, built.receiveEnvelope, (r, args) => ({ started: false, terminal: false, recovered: false, reason: r.ok ? null : r.reason, executionId: String(args[0].executionId) })),
    requestCancel: observed('cancel', hooks, built.requestCancel, (r, args) => ({ started: false, terminal: r.ok && r.value.state === 'cancelled', recovered: false, reason: null, executionId: String(args[1]) })),
    snapshot: built.snapshot,
    delegations: built.delegations,
    grants: built.grants,
    events: built.events,
  };
}

type Classified = { started: boolean; terminal: boolean; recovered: boolean; reason: string | null; executionId: string | null };

/** Wraps one public operation so that every decision is reported exactly once, with its timing and bounded reason. */
function observed<A extends unknown[], R extends { ok: boolean }>(operation: ExecutionDecision['operation'], hooks: ExecutionHooks,
  call: (...args: A) => Promise<R>, classify: (result: R, args: A) => Classified): (...args: A) => Promise<R> {
  return async (...args: A) => {
    const started = performance.now();
    const executionIdOf = (): string | null => {
      const first = args[0] as { executionId?: string; tenantId?: string } | undefined;
      return typeof first?.executionId === 'string' ? first.executionId : null;
    };
    try {
      const result = await call(...args);
      const c = classify(result, args);
      hooks.onDecision?.({ operation, executionId: c.executionId ?? executionIdOf(), outcome: result.ok ? 'accepted' : 'refused',
        reason: result.ok ? null : c.reason, durationMs: performance.now() - started, recovered: c.recovered, terminal: c.terminal, started: c.started });
      return result;
    } catch (error) {
      hooks.onDecision?.({ operation, executionId: executionIdOf(), outcome: 'error', reason: null, durationMs: performance.now() - started,
        recovered: false, terminal: false, started: false });
      throw error;
    }
  };
}

function buildStore(runTenant: TenantRunner, hooks: ExecutionHooks): AgentExecutionStore {

  const beforeCommit = async (label: string) => { await hooks.beforeCommit?.(label); };

  /** Records one decision. Always called inside the transaction that made (or refused) the decision. */
  async function audit(client: TenantQueryable, tenantId: string, executionId: string, row: AuditRow): Promise<void> {
    await client.query(
      `INSERT INTO aegis.agent_execution_events (tenant_id, execution_id, event_type, outcome, reason, actor_agent, actor_instance,
         fencing_token, delegation_seq, grant_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [tenantId, executionId, row.eventType, row.outcome, row.reason, row.actorAgent, row.actorInstance, row.fencingToken,
        row.delegationSeq, row.grantId],
    );
  }

  /** Locks the execution row and, when a fence is given, proves the caller still holds the current lease. */
  async function lockAndFence(client: TenantQueryable, tenantId: string, executionId: string, fence: Fence | null):
    Promise<{ ok: true; row: ExecRow } | { ok: false; reason: FenceRefusal }> {
    const result = await client.query<ExecRow>(
      `SELECT ${EXEC_COLUMNS} FROM aegis.agent_executions e WHERE e.execution_id = $1 AND e.tenant_id = $2 FOR UPDATE`,
      [executionId, tenantId],
    );
    const row = result.rows[0];
    if (!row) return { ok: false, reason: 'not_found' };
    if (fence) {
      const current = row.lease_live && row.lease_agent_id === fence.agentId && row.lease_instance === fence.instance
        && Number(row.fencing_token) === fence.fencingToken;
      if (!current) return { ok: false, reason: 'stale_fence' };
    }
    return { ok: true, row };
  }

  /** Expired open grants are revoked here, under the execution lock, so no expired grant can authorise an envelope. */
  async function sweepExpiredGrants(client: TenantQueryable, executionId: string): Promise<void> {
    await client.query(
      `UPDATE aegis.agent_grants SET status = 'revoked', revoked_at = clock_timestamp()
        WHERE execution_id = $1 AND status = 'open' AND expires_at <= clock_timestamp()`,
      [executionId],
    );
  }

  async function registrations(client: TenantQueryable): Promise<Map<string, AgentDefinition>> {
    const result = await client.query<{ agent_id: string; role: AgentDefinition['role']; registered_scopes: string[] }>(
      `SELECT agent_id, role, registered_scopes FROM aegis.agent_registrations WHERE status = 'active'`, []);
    return new Map(result.rows.map((r) => [r.agent_id, { id: r.agent_id, role: r.role, registeredScopes: r.registered_scopes }]));
  }

  async function delegationRows(client: TenantQueryable, executionId: string): Promise<DelegationDbRow[]> {
    const result = await client.query<DelegationDbRow>(
      `SELECT seq, parent_seq, depth, from_agent, to_agent, effective_scopes, chain_digest
         FROM aegis.agent_delegations WHERE execution_id = $1 ORDER BY seq`, [executionId]);
    return result.rows;
  }

  /** The chain from the root to the hop `seq`, reconstructed from the persisted hops. */
  function chainTo(rows: DelegationDbRow[], seq: number | null): DelegationChain {
    if (seq === null) return [];
    const bySeq = new Map(rows.map((r) => [r.seq, r]));
    const links: DelegationLink[] = [];
    let cursor = bySeq.get(seq);
    while (cursor) {
      links.unshift({ from: cursor.from_agent, to: cursor.to_agent, effectiveScopes: cursor.effective_scopes });
      cursor = cursor.parent_seq === null ? undefined : bySeq.get(cursor.parent_seq);
    }
    return links;
  }

  async function openAndConsumedGrants(client: TenantQueryable, tenantId: string, executionId: string, principalRef: string):
    Promise<{ open: Grant[]; consumed: Grant[] }> {
    const result = await client.query<GrantDbRow>(
      `SELECT grant_id, kind, chain_digest, depth, from_agent, to_agent, action, arguments_digest, required_scopes, status,
              expires_at, consumed_by_agent, consumed_by_fencing_token::text AS consumed_by_fencing_token
         FROM aegis.agent_grants WHERE execution_id = $1 AND status IN ('open', 'consumed')`, [executionId]);
    const toGrant = (g: GrantDbRow): Grant => ({
      grantId: g.grant_id, kind: g.kind, executionId, tenantId, principalRef, chainDigest: g.chain_digest, depth: g.depth,
      from: g.from_agent, to: g.to_agent, action: g.action, argumentsDigest: g.arguments_digest, requiredScopes: g.required_scopes,
    });
    return {
      open: result.rows.filter((g) => g.status === 'open').map(toGrant),
      consumed: result.rows.filter((g) => g.status === 'consumed').map(toGrant),
    };
  }

  function recordOf(row: ExecRow): ExecutionRecord {
    return {
      executionId: row.execution_id, tenantId: row.tenant_id, principalRef: row.principal_ref, principalScopes: row.principal_scopes,
      rootAgent: row.root_agent,
      limits: { maxDepth: row.max_depth, maxDelegations: row.max_delegations, maxSteps: row.max_steps },
    };
  }

  function stateOf(row: ExecRow, open: Grant[], consumed: Grant[]): ExecutionState {
    return { delegationsIssued: row.delegations_issued, stepsTaken: row.steps_taken, openGrants: open, consumedGrants: consumed };
  }

  /** Runs one locked, fenced decision. Refusals are audited and return a value. Only thrown errors roll the transaction back. */
  function fencedWrite<T, R extends string>(tenantId: string, executionId: string, fence: Fence | null,
    decide: (client: TenantQueryable, row: ExecRow) => Promise<Result<T, R | string>>, label: string,
    refusedEvent: (reason: string) => AuditRow, completesCancellation = false): Promise<Result<T, string>> {
    assertUuid(tenantId, 'tenantId');
    assertUuid(executionId, 'executionId');
    return runTenant(tenantId, async (client) => {
      const locked = await lockAndFence(client, tenantId, executionId, fence);
      if (!locked.ok) {
        if (locked.reason === 'stale_fence') await audit(client, tenantId, executionId, refusedEvent('stale_fence'));
        await beforeCommit(`${label}:${locked.reason}`);
        return { ok: false as const, reason: locked.reason };
      }
      if (locked.row.cancel_requested && !completesCancellation) {
        await audit(client, tenantId, executionId, refusedEvent('cancel_requested'));
        await beforeCommit(`${label}:cancel_requested`);
        return { ok: false as const, reason: 'cancel_requested' };
      }
      const outcome = await decide(client, locked.row);
      await beforeCommit(`${label}:${outcome.ok ? 'accepted' : outcome.reason}`);
      return outcome;
    });
  }

  /**
   * The single implementation of grant consumption, shared by the fenced path (the lease holder consumes an envelope) and the recipient
   * path (P5: a receiver consumes its inbound grant). Runs under the execution lock held by the caller.
   */
  async function consumeDecision(client: TenantQueryable, row: ExecRow, tenantId: string, executionId: string,
    actor: { agentId: string; instance: string | null; fencingToken: number }, envelope: unknown):
    Promise<Result<{ grantId: string; stepsTaken: number }, string>> {
    await sweepExpiredGrants(client, executionId);
    const { open, consumed } = await openAndConsumedGrants(client, tenantId, executionId, row.principal_ref);
    const structure = checkEnvelopeStructure(envelope);
    const refuse = async (reason: string) => {
      await audit(client, tenantId, executionId, { eventType: reason === 'step_budget_exceeded' ? 'step_refused' : 'grant_rejected',
        outcome: 'refused', reason, actorAgent: actor.agentId, actorInstance: actor.instance, fencingToken: actor.fencingToken,
        delegationSeq: null, grantId: null });
      return { ok: false as const, reason };
    };
    if (!structure.ok) return refuse(structure.reason);
    const authorised = authoriseEnvelope({ value: envelope, record: recordOf(row), state: stateOf(row, open, consumed) });
    if (!authorised.ok) return refuse(authorised.reason);
    const grant = authorised.grant;
    const consumedRows = await client.query<{ grant_id: string }>(
      `UPDATE aegis.agent_grants SET status = 'consumed', consumed_at = clock_timestamp(), consumed_by_agent = $2,
           consumed_by_fencing_token = $3
        WHERE grant_id = $1 AND status = 'open' RETURNING grant_id`,
      [grant.grantId, actor.agentId, actor.fencingToken]);
    if (consumedRows.rows.length !== 1) throw new Error('grant changed under the execution lock');
    // The step counter is maintained by the database when the grant is consumed (migration 018), not written here.
    await audit(client, tenantId, executionId, { eventType: 'grant_consumed', outcome: 'accepted', reason: null,
      actorAgent: actor.agentId, actorInstance: actor.instance, fencingToken: actor.fencingToken, delegationSeq: null, grantId: grant.grantId });
    return { ok: true, value: { grantId: grant.grantId, stepsTaken: authorised.state.stepsTaken } };
  }

  return {
    async createExecution(input) {
      assertUuid(input.tenantId, 'tenantId');
      if (input.idempotencyKey.length === 0 || input.idempotencyKey.length > 200) throw new RangeError('idempotency key must be 1 to 200 characters');
      const result = await runTenant(input.tenantId, async (client) => {
        const inserted = await client.query<{ execution_id: string }>(
          `INSERT INTO aegis.agent_executions (tenant_id, idempotency_key, principal_ref, principal_scopes, root_agent, max_depth,
             max_delegations, max_steps, grant_ttl_seconds, max_attempts)
           VALUES ($1, $2, $3, $4, 'orchestrator', $5, $6, $7, $8, $9)
           ON CONFLICT (tenant_id, idempotency_key) DO NOTHING RETURNING execution_id`,
          [input.tenantId, input.idempotencyKey, input.principalRef, [...input.principalScopes], input.limits.maxDepth,
            input.limits.maxDelegations, input.limits.maxSteps, input.grantTtlSeconds, input.maxAttempts]);
        if (inserted.rows[0]) {
          const executionId = inserted.rows[0].execution_id;
          await audit(client, input.tenantId, executionId, { eventType: 'execution_created', outcome: 'accepted', reason: null,
            actorAgent: null, actorInstance: null, fencingToken: 0, delegationSeq: null, grantId: null });
          await beforeCommit('create:accepted');
          return { executionId, created: true };
        }
        const existing = await client.query<{ execution_id: string }>(
          'SELECT execution_id FROM aegis.agent_executions WHERE tenant_id = $1 AND idempotency_key = $2',
          [input.tenantId, input.idempotencyKey]);
        if (!existing.rows[0]) throw new Error('execution could not be created or found');
        return { executionId: existing.rows[0].execution_id, created: false };
      });
      return result;
    },

    async claim({ tenantId, executionId, spiffeId, instance, leaseSeconds }) {
      assertUuid(tenantId, 'tenantId');
      assertUuid(executionId, 'executionId');
      if (instance.length === 0 || instance.length > 128) throw new RangeError('instance must be 1 to 128 characters');
      if (!Number.isInteger(leaseSeconds) || leaseSeconds < 1 || leaseSeconds > 3600) throw new RangeError('leaseSeconds must be 1 to 3600');
      return runTenant(tenantId, async (client) => {
        // The worker is bound to a registration by its verified SPIFFE ID. Only the orchestrator role may drive an execution.
        const who = await client.query<{ agent_id: string; role: string }>(
          // P8: the registration must be the agent of this database session. The session's identity comes from its login role, so a
          // process cannot claim as another agent by passing a different SPIFFE identifier.
          `SELECT agent_id, role FROM aegis.agent_registrations WHERE spiffe_id = $1 AND status = 'active' AND agent_id = aegis.current_agent()`, [spiffeId]);
        const agent = who.rows[0];
        if (!agent) {
          const row = await lockAndFence(client, tenantId, executionId, null);
          if (row.ok) await audit(client, tenantId, executionId, { eventType: 'claim_refused', outcome: 'refused', reason: 'not_registered',
            actorAgent: null, actorInstance: null, fencingToken: null, delegationSeq: null, grantId: null });
          await beforeCommit('claim:not_registered');
          return { ok: false as const, reason: row.ok ? 'not_registered' : 'not_found' };
        }
        const locked = await lockAndFence(client, tenantId, executionId, null);
        if (!locked.ok) { await beforeCommit('claim:not_found'); return { ok: false as const, reason: 'not_found' as const }; }
        const row = locked.row;
        const refuse = async (reason: ClaimRefusal) => {
          await audit(client, tenantId, executionId, { eventType: 'claim_refused', outcome: 'refused', reason, actorAgent: agent.agent_id,
            actorInstance: instance, fencingToken: Number(row.fencing_token), delegationSeq: null, grantId: null });
          await beforeCommit(`claim:${reason}`);
          return { ok: false as const, reason };
        };
        if (agent.role !== 'orchestrator') return refuse('not_orchestrator');
        if (TERMINAL.includes(row.status)) return refuse('terminal');
        if (row.lease_live) return refuse('lease_held');
        if (row.cancel_requested) {
          // Nothing holds the lease, so the cancellation is applied now, and open grants are revoked with it.
          await client.query(`UPDATE aegis.agent_executions SET status = 'cancelled', version = version + 1, updated_at = clock_timestamp(),
              workflow_stage = CASE WHEN workflow_stage IN ('completed', 'insufficient_evidence', 'failed', 'cancelled') THEN workflow_stage ELSE 'cancelled' END
            WHERE execution_id = $1`, [executionId]);
          await client.query(`UPDATE aegis.agent_grants SET status = 'revoked', revoked_at = clock_timestamp()
            WHERE execution_id = $1 AND status = 'open'`, [executionId]);
          await audit(client, tenantId, executionId, { eventType: 'cancelled', outcome: 'accepted', reason: 'cancel_requested',
            actorAgent: null, actorInstance: null, fencingToken: Number(row.fencing_token), delegationSeq: null, grantId: null });
          return refuse('cancel_requested');
        }
        if (row.attempts >= row.max_attempts) {
          await client.query(`UPDATE aegis.agent_executions SET status = 'failed', lease_agent_id = NULL, lease_instance = NULL,
              lease_expires_at = NULL, version = version + 1, updated_at = clock_timestamp(),
              workflow_stage = CASE WHEN workflow_stage IN ('completed', 'insufficient_evidence', 'failed', 'cancelled') THEN workflow_stage ELSE 'failed' END
            WHERE execution_id = $1`, [executionId]);
          await client.query(`UPDATE aegis.agent_grants SET status = 'revoked', revoked_at = clock_timestamp()
            WHERE execution_id = $1 AND status = 'open'`, [executionId]);
          await audit(client, tenantId, executionId, { eventType: 'retry_exhausted', outcome: 'accepted', reason: 'retries_exhausted',
            actorAgent: null, actorInstance: null, fencingToken: Number(row.fencing_token), delegationSeq: null, grantId: null });
          return refuse('retries_exhausted');
        }
        const recovered = Number(row.fencing_token) > 0;
        const updated = await client.query<{ fencing_token: string; attempts: number }>(
          `UPDATE aegis.agent_executions
              SET status = 'running', lease_agent_id = $2, lease_instance = $3,
                  lease_expires_at = clock_timestamp() + make_interval(secs => $4),
                  fencing_token = fencing_token + 1, attempts = attempts + 1, version = version + 1, updated_at = clock_timestamp()
            WHERE execution_id = $1
            RETURNING fencing_token::text AS fencing_token, attempts`,
          [executionId, agent.agent_id, instance, leaseSeconds]);
        const next = updated.rows[0];
        await audit(client, tenantId, executionId, { eventType: 'claimed', outcome: 'accepted', reason: recovered ? 'recovered' : null,
          actorAgent: agent.agent_id, actorInstance: instance, fencingToken: Number(next.fencing_token), delegationSeq: null, grantId: null });
        await beforeCommit('claim:accepted');
        return { ok: true as const, value: { fencingToken: Number(next.fencing_token), attempts: next.attempts, recovered, agentId: agent.agent_id } };
      });
    },

    async renew(fence, leaseSeconds) {
      return fencedWrite<{ leaseSeconds: number }, string>(fence.tenantId, fence.executionId, fence, async (client) => {
        await client.query(`UPDATE aegis.agent_executions SET lease_expires_at = clock_timestamp() + make_interval(secs => $2),
            version = version + 1, updated_at = clock_timestamp() WHERE execution_id = $1`, [fence.executionId, leaseSeconds]);
        await audit(client, fence.tenantId, fence.executionId, { eventType: 'renewed', outcome: 'accepted', reason: null,
          actorAgent: fence.agentId, actorInstance: fence.instance, fencingToken: fence.fencingToken, delegationSeq: null, grantId: null });
        return { ok: true, value: { leaseSeconds } };
      }, 'renew', (reason) => ({ eventType: 'fenced_write_refused', outcome: 'refused', reason, actorAgent: fence.agentId,
        actorInstance: fence.instance, fencingToken: fence.fencingToken, delegationSeq: null, grantId: null }));
    },

    async release(fence, nextStatus, reason) {
      return fencedWrite<{ status: string }, string>(fence.tenantId, fence.executionId, fence, async (client, row) => {
        if (nextStatus === 'cancelled' && !row.cancel_requested) return { ok: false, reason: 'cancel_not_requested' };
        await client.query(`UPDATE aegis.agent_executions SET status = $2, lease_agent_id = NULL, lease_instance = NULL,
            lease_expires_at = NULL, version = version + 1, updated_at = clock_timestamp() WHERE execution_id = $1`,
        [fence.executionId, nextStatus]);
        if (TERMINAL.includes(nextStatus)) {
          await client.query(`UPDATE aegis.agent_grants SET status = 'revoked', revoked_at = clock_timestamp()
            WHERE execution_id = $1 AND status = 'open'`, [fence.executionId]);
        }
        await audit(client, fence.tenantId, fence.executionId, { eventType: nextStatus === 'pending' ? 'released' : nextStatus,
          outcome: 'accepted', reason, actorAgent: fence.agentId, actorInstance: fence.instance, fencingToken: fence.fencingToken,
          delegationSeq: null, grantId: null });
        return { ok: true, value: { status: nextStatus } };
      }, 'release', (r) => ({ eventType: 'fenced_write_refused', outcome: 'refused', reason: r, actorAgent: fence.agentId,
        actorInstance: fence.instance, fencingToken: fence.fencingToken, delegationSeq: null, grantId: null }), true);
    },

    async recordDelegation(fence, input) {
      return fencedWrite<{ seq: number; depth: number }, string>(fence.tenantId, fence.executionId, fence, async (client, row) => {
        const rows = await delegationRows(client, fence.executionId);
        const parentSeq = input.parentSeq;
        const chain = chainTo(rows, parentSeq);
        const agents = await registrations(client);
        const state = stateOf(row, [], []);
        const decision = decideDelegation({ record: recordOf(row), state, chain, agents, from: holderOf(row.root_agent, chain),
          to: input.to, requestedScopes: input.requestedScopes });
        if (!decision.allowed) {
          await audit(client, fence.tenantId, fence.executionId, { eventType: 'delegation_refused', outcome: 'refused', reason: decision.reason,
            actorAgent: fence.agentId, actorInstance: fence.instance, fencingToken: fence.fencingToken, delegationSeq: null, grantId: null });
          return { ok: false, reason: decision.reason };
        }
        const seq = rows.length === 0 ? 1 : Math.max(...rows.map((r) => r.seq)) + 1;
        const depth = chain.length + 1;
        const nextChain = extendChain(chain, decision.link);
        const digest = chainDigest(nextChain);
        // The same hop recorded twice is a duplicate, usually a retried message. The unique (execution, chain) constraint is the backstop.
        if (rows.some((r) => r.chain_digest === digest)) {
          await audit(client, fence.tenantId, fence.executionId, { eventType: 'delegation_refused', outcome: 'refused', reason: 'duplicate_delegation',
            actorAgent: fence.agentId, actorInstance: fence.instance, fencingToken: fence.fencingToken, delegationSeq: null, grantId: null });
          return { ok: false, reason: 'duplicate_delegation' };
        }
        await client.query(
          `INSERT INTO aegis.agent_delegations (tenant_id, execution_id, seq, parent_seq, depth, from_agent, to_agent, effective_scopes,
             chain_digest, fencing_token)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
          [fence.tenantId, fence.executionId, seq, parentSeq, depth, decision.link.from, decision.link.to,
            [...decision.link.effectiveScopes], chainDigest(nextChain), fence.fencingToken]);
        // The global counter is updated under the same lock. The CHECK constraint on the row refuses any overshoot as a backstop.
        const counted = recordDelegation(state);
        await client.query('UPDATE aegis.agent_executions SET delegations_issued = $2, version = version + 1, updated_at = clock_timestamp() WHERE execution_id = $1',
          [fence.executionId, counted.delegationsIssued]);
        await audit(client, fence.tenantId, fence.executionId, { eventType: 'delegation_recorded', outcome: 'accepted', reason: null,
          actorAgent: fence.agentId, actorInstance: fence.instance, fencingToken: fence.fencingToken, delegationSeq: seq, grantId: null });
        return { ok: true, value: { seq, depth } };
      }, 'delegate', (reason) => ({ eventType: 'fenced_write_refused', outcome: 'refused', reason, actorAgent: fence.agentId,
        actorInstance: fence.instance, fencingToken: fence.fencingToken, delegationSeq: null, grantId: null }));
    },

    async issueGrant(fence, input) {
      return fencedWrite<{ grantId: string }, string>(fence.tenantId, fence.executionId, fence, async (client, row) => {
        await sweepExpiredGrants(client, fence.executionId);
        const rows = await delegationRows(client, fence.executionId);
        const chain = chainTo(rows, input.chainSeq);
        const { open, consumed } = await openAndConsumedGrants(client, fence.tenantId, fence.executionId, row.principal_ref);
        const issued = issueGrant({ record: recordOf(row), state: stateOf(row, open, consumed), chain, kind: input.kind,
          action: input.action, argumentsDigest: input.argumentsDigest, requiredScopes: input.requiredScopes, direction: input.direction });
        if (!issued.ok) {
          await audit(client, fence.tenantId, fence.executionId, { eventType: 'grant_refused', outcome: 'refused', reason: issued.reason,
            actorAgent: fence.agentId, actorInstance: fence.instance, fencingToken: fence.fencingToken, delegationSeq: input.chainSeq, grantId: null });
          return { ok: false, reason: issued.reason };
        }
        const g = issued.grant;
        // Pre-check under the execution lock: one open grant per exact envelope. The partial unique index is the backstop.
        const duplicate = await client.query(
          `SELECT 1 FROM aegis.agent_grants WHERE execution_id = $1 AND status = 'open' AND kind = $2 AND chain_digest = $3 AND depth = $4
             AND from_agent = $5 AND to_agent = $6 AND action = $7 AND arguments_digest = $8`,
          [fence.executionId, g.kind, g.chainDigest, g.depth, g.from, g.to, g.action, g.argumentsDigest]);
        if (duplicate.rows.length > 0) {
          await audit(client, fence.tenantId, fence.executionId, { eventType: 'grant_refused', outcome: 'refused', reason: 'duplicate_open_grant',
            actorAgent: fence.agentId, actorInstance: fence.instance, fencingToken: fence.fencingToken, delegationSeq: input.chainSeq, grantId: null });
          return { ok: false, reason: 'duplicate_open_grant' };
        }
        const inserted = await client.query<{ grant_id: string }>(
          `INSERT INTO aegis.agent_grants (tenant_id, execution_id, kind, chain_digest, depth, from_agent, to_agent, action, arguments_digest,
             required_scopes, issued_by_fencing_token, expires_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, clock_timestamp() + make_interval(secs => $12))
           RETURNING grant_id`,
          [fence.tenantId, fence.executionId, g.kind, g.chainDigest, g.depth, g.from, g.to, g.action, g.argumentsDigest,
            [...g.requiredScopes], fence.fencingToken, row.grant_ttl_seconds]);
        const grantId = inserted.rows[0].grant_id;
        await audit(client, fence.tenantId, fence.executionId, { eventType: 'grant_issued', outcome: 'accepted', reason: null,
          actorAgent: fence.agentId, actorInstance: fence.instance, fencingToken: fence.fencingToken, delegationSeq: input.chainSeq, grantId });
        return { ok: true, value: { grantId } };
      }, 'grant', (reason) => ({ eventType: 'fenced_write_refused', outcome: 'refused', reason, actorAgent: fence.agentId,
        actorInstance: fence.instance, fencingToken: fence.fencingToken, delegationSeq: null, grantId: null }));
    },

    async consumeEnvelope(fence, envelope) {
      return fencedWrite<{ grantId: string; stepsTaken: number }, string>(fence.tenantId, fence.executionId, fence, async (client, row) =>
        consumeDecision(client, row, fence.tenantId, fence.executionId,
          { agentId: fence.agentId, instance: fence.instance, fencingToken: fence.fencingToken }, envelope),
      'consume', (reason) => ({ eventType: 'fenced_write_refused', outcome: 'refused', reason, actorAgent: fence.agentId,
        actorInstance: fence.instance, fencingToken: fence.fencingToken, delegationSeq: null, grantId: null }));
    },

    async receiveEnvelope({ tenantId, executionId, recipient, sender, envelope }) {
      assertUuid(tenantId, 'tenantId');
      assertUuid(executionId, 'executionId');
      return runTenant(tenantId, async (client) => {
        const locked = await lockAndFence(client, tenantId, executionId, null);
        if (!locked.ok) { await beforeCommit('receive:not_found'); return { ok: false as const, reason: 'not_found' }; }
        const row = locked.row;
        const refuseAt = async (reason: string) => {
          await audit(client, tenantId, executionId, { eventType: 'grant_rejected', outcome: 'refused', reason, actorAgent: recipient,
            actorInstance: null, fencingToken: Number(row.fencing_token), delegationSeq: null, grantId: null });
          await beforeCommit(`receive:${reason}`);
          return { ok: false as const, reason };
        };
        if (TERMINAL.includes(row.status)) return refuseAt('terminal');
        const structure = checkEnvelopeStructure(envelope);
        if (!structure.ok) return refuseAt(structure.reason);
        // Addressing is checked before authorisation so a message for another agent is refused by name, not by grant lookup.
        if (structure.envelope.to !== recipient) return refuseAt('wrong_recipient');
        if (structure.envelope.from !== sender) return refuseAt('sender_mismatch');
        const consumed = await consumeDecision(client, row, tenantId, executionId,
          { agentId: recipient, instance: null, fencingToken: Number(row.fencing_token) }, envelope);
        if (!consumed.ok) {
          await beforeCommit(`receive:${consumed.reason}`);
          return consumed;
        }
        // Finalisation is not a side effect of receiving a result. The orchestration layer decides what a result means (see
        // messaging/handlers.ts): an intermediate result advances the workflow, and only the final review completes it.
        await beforeCommit('receive:accepted');
        return { ok: true as const, value: { grantId: consumed.value.grantId } };
      });
    },

    async requestCancel(tenantId, executionId, actorDigest, reason) {
      assertUuid(tenantId, 'tenantId');
      assertUuid(executionId, 'executionId');
      if (reason.trim().length === 0 || reason.length > 200) throw new RangeError('reason must be 1 to 200 characters');
      return runTenant(tenantId, async (client) => {
        const locked = await lockAndFence(client, tenantId, executionId, null);
        if (!locked.ok) { await beforeCommit('cancel:not_found'); return { ok: false as const, reason: 'not_found' as const }; }
        const row = locked.row;
        if (TERMINAL.includes(row.status)) { await beforeCommit('cancel:terminal'); return { ok: false as const, reason: 'terminal' as const }; }
        if (row.lease_live) {
          // A running attempt honours the request at its next fenced write.
          await client.query(`UPDATE aegis.agent_executions SET cancel_requested = true, cancel_reason = COALESCE(cancel_reason, $2),
              version = version + 1, updated_at = clock_timestamp() WHERE execution_id = $1`, [executionId, reason]);
          await audit(client, tenantId, executionId, { eventType: 'cancel_requested', outcome: 'accepted', reason: 'lease_held',
            actorAgent: null, actorInstance: actorDigest, fencingToken: Number(row.fencing_token), delegationSeq: null, grantId: null });
          await beforeCommit('cancel:requested');
          return { ok: true as const, value: { state: 'cancel_requested' as const } };
        }
        await client.query(`UPDATE aegis.agent_executions SET status = 'cancelled', cancel_requested = true,
            cancel_reason = COALESCE(cancel_reason, $2), version = version + 1, updated_at = clock_timestamp() WHERE execution_id = $1`,
        [executionId, reason]);
        await client.query(`UPDATE aegis.agent_grants SET status = 'revoked', revoked_at = clock_timestamp()
          WHERE execution_id = $1 AND status = 'open'`, [executionId]);
        await audit(client, tenantId, executionId, { eventType: 'cancelled', outcome: 'accepted', reason: 'operator_request',
          actorAgent: null, actorInstance: actorDigest, fencingToken: Number(row.fencing_token), delegationSeq: null, grantId: null });
        await beforeCommit('cancel:cancelled');
        return { ok: true as const, value: { state: 'cancelled' as const } };
      });
    },

    async snapshot(tenantId, executionId) {
      return runTenant(tenantId, async (client) => {
        const result = await client.query<ExecRow>(`SELECT ${EXEC_COLUMNS} FROM aegis.agent_executions e WHERE e.execution_id = $1`, [executionId]);
        const row = result.rows[0];
        if (!row) return null;
        return {
          executionId: row.execution_id, status: row.status, fencingToken: Number(row.fencing_token), attempts: row.attempts,
          maxAttempts: row.max_attempts, delegationsIssued: row.delegations_issued, maxDelegations: row.max_delegations,
          stepsTaken: row.steps_taken, maxSteps: row.max_steps, leaseAgentId: row.lease_live ? row.lease_agent_id : null,
          cancelRequested: row.cancel_requested, principalRef: row.principal_ref, principalScopes: row.principal_scopes,
        };
      });
    },

    async delegations(tenantId, executionId) {
      return runTenant(tenantId, async (client) => (await delegationRows(client, executionId)).map((r) => ({
        seq: r.seq, parentSeq: r.parent_seq, depth: r.depth, from: r.from_agent, to: r.to_agent, chainDigest: r.chain_digest,
      })));
    },

    async grants(tenantId, executionId) {
      return runTenant(tenantId, async (client) => {
        const result = await client.query<{ grant_id: string; status: string; kind: string; to_agent: string; action: string;
          consumed_by_agent: string | null; consumed_by_fencing_token: string | null }>(
          `SELECT grant_id, status, kind, to_agent, action, consumed_by_agent, consumed_by_fencing_token::text AS consumed_by_fencing_token
             FROM aegis.agent_grants WHERE execution_id = $1 ORDER BY issued_at, grant_id`, [executionId]);
        return result.rows.map((r) => ({ grantId: r.grant_id, status: r.status, kind: r.kind, to: r.to_agent, action: r.action,
          consumedBy: r.consumed_by_agent, consumedByFencingToken: r.consumed_by_fencing_token === null ? null : Number(r.consumed_by_fencing_token) }));
      });
    },

    async events(tenantId, executionId) {
      return runTenant(tenantId, async (client) => {
        const result = await client.query<{ event_type: string; outcome: 'accepted' | 'refused'; reason: string | null;
          actor_agent: string | null; actor_instance: string | null; fencing_token: string | null; delegation_seq: number | null; grant_id: string | null }>(
          `SELECT event_type, outcome, reason, actor_agent, actor_instance, fencing_token::text AS fencing_token, delegation_seq, grant_id
             FROM aegis.agent_execution_events WHERE execution_id = $1 ORDER BY event_id`, [executionId]);
        return result.rows.map((r) => ({ eventType: r.event_type, outcome: r.outcome, reason: r.reason, actorAgent: r.actor_agent,
          actorInstance: r.actor_instance, fencingToken: r.fencing_token === null ? null : Number(r.fencing_token),
          delegationSeq: r.delegation_seq, grantId: r.grant_id }));
      });
    },
  };
}

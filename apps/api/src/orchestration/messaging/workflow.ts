import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { TenantQueryable } from '../../security/tool-approval-store.js';
import { createAgentExecutionStore, joinTransaction, type ExecutionHooks, type Fence } from '../persistence/execution-store.js';
import { argumentsDigest } from '../delegation.js';
import { enqueueMessage } from './outbox.js';
import { buildWireMessage, payloadDigest } from './wire.js';
import { withMessagingContext } from './context.js';
import { ACTIONS } from '../../investigation/contracts.js';

/**
 * Orchestration steps that produce messages. A step is one P4 decision and its outbound message, committed together: the delegation,
 * both grants (the request, and the return grant for the reply), the request message, the stage transition and the lease release. A
 * step that cannot be authorised rolls back to its savepoint, so no partial step survives.
 *
 * The stage transition is validated by the database (migration 018). The orchestrator decides which stage follows; the database checks
 * that the transition is one the state machine allows.
 */

export const ROOT_AGENT = 'orchestrator';
export const TRIAGE_AGENT = 'triage';
export const RETRIEVAL_AGENT = 'retrieval';
export const REVIEWER_AGENT = 'reviewer';
export const WORKFLOW_SCOPES = ['document:read'] as const;
export { ACTIONS };

/** The request actions and the result action each one returns. A reply must use exactly the action its grant names. */
export const STEP_ACTIONS = {
  [TRIAGE_AGENT]: { request: ACTIONS.plan, result: ACTIONS.planResult },
  [RETRIEVAL_AGENT]: { request: ACTIONS.retrieve, result: ACTIONS.retrieveResult },
  [REVIEWER_AGENT]: { request: ACTIONS.review, result: ACTIONS.reviewResult },
} as const;

export interface StepInput {
  readonly tenantId: string;
  readonly fence: Fence;
  readonly to: string;
  readonly requestedScopes: readonly string[];
  readonly action: string;
  readonly resultAction: string;
  readonly arguments: Record<string, unknown>;
  /** Stage to move to in the same transaction, if the workflow has one. The database checks the transition. */
  readonly nextStage?: string;
  readonly maxAttempts?: number;
}

export type StepOutcome =
  | { readonly ok: true; readonly delegationSeq: number; readonly requestMessageId: string; readonly resultGrantId: string }
  | { readonly ok: false; readonly reason: string };

/** Records a refusal of a step as an execution audit row, after its writes were rolled back to the savepoint. */
async function recordRefusal(client: TenantQueryable, input: StepInput, eventType: string, reason: string): Promise<void> {
  await client.query(
    `INSERT INTO aegis.agent_execution_events (tenant_id, execution_id, event_type, outcome, reason, actor_agent, actor_instance, fencing_token)
     VALUES ($1, $2, $3, 'refused', $4, $5, $6, $7)`,
    [input.tenantId, input.fence.executionId, eventType, reason, input.fence.agentId, input.fence.instance, input.fence.fencingToken]);
}

/** One step, inside a transaction the caller owns. Releases the lease when it succeeds. */
export async function dispatchStepInTx(client: TenantQueryable, hooks: ExecutionHooks, input: StepInput): Promise<StepOutcome> {
  const digest = argumentsDigest(input.arguments);
  const store = createAgentExecutionStore(joinTransaction(client, input.tenantId), hooks);
  await client.query('SAVEPOINT p8_step', []);
  const refuse = async (eventType: string, reason: string): Promise<StepOutcome> => {
    await client.query('ROLLBACK TO SAVEPOINT p8_step', []);
    await recordRefusal(client, input, eventType, reason);
    return { ok: false, reason };
  };

  const delegated = await store.recordDelegation(input.fence, { parentSeq: null, to: input.to, requestedScopes: [...input.requestedScopes] });
  if (!delegated.ok) return refuse('delegation_refused', delegated.reason);
  const hop = (await client.query<{ chain_digest: string; depth: number }>(
    'SELECT chain_digest, depth FROM aegis.agent_delegations WHERE execution_id = $1 AND seq = $2',
    [input.fence.executionId, delegated.value.seq])).rows[0];
  if (!hop) return refuse('delegation_refused', 'discontinuous_chain');

  const request = await store.issueGrant(input.fence, { chainSeq: delegated.value.seq, kind: 'request', action: input.action,
    argumentsDigest: digest, requiredScopes: [...input.requestedScopes] });
  if (!request.ok) return refuse('grant_refused', request.reason);
  const reply = await store.issueGrant(input.fence, { chainSeq: delegated.value.seq, kind: 'result', direction: 'return',
    action: input.resultAction, argumentsDigest: digest, requiredScopes: [...input.requestedScopes] });
  if (!reply.ok) return refuse('grant_refused', reply.reason);

  const principal = (await client.query<{ principal_ref: string }>('SELECT principal_ref FROM aegis.agent_executions WHERE execution_id = $1',
    [input.fence.executionId])).rows[0]?.principal_ref;
  if (!principal) return refuse('grant_refused', 'not_found');

  const payload = { arguments: input.arguments } as Record<string, unknown>;
  const messageId = randomUUID();
  const wire = buildWireMessage({ messageId, tenantId: input.tenantId, executionId: input.fence.executionId, kind: 'request', payload,
    envelope: { kind: 'request', executionId: input.fence.executionId, tenantId: input.tenantId, principalRef: principal,
      from: input.fence.agentId, to: input.to, depth: hop.depth, chainDigest: hop.chain_digest, action: input.action, argumentsDigest: digest } });
  await enqueueMessage(client, { messageId, tenantId: input.tenantId, executionId: input.fence.executionId, sender: input.fence.agentId,
    destination: input.to, kind: 'request', envelope: wire.envelope, payload: wire.payload, payloadDigest: payloadDigest(payload),
    maxAttempts: input.maxAttempts ?? 6 });

  if (input.nextStage !== undefined) {
    await client.query('UPDATE aegis.agent_executions SET workflow_stage = $2, updated_at = clock_timestamp() WHERE execution_id = $1',
      [input.fence.executionId, input.nextStage]);
  }
  const released = await store.release(input.fence, 'pending', 'dispatched');
  if (!released.ok) return refuse('fenced_write_refused', released.reason);
  return { ok: true, delegationSeq: delegated.value.seq, requestMessageId: messageId, resultGrantId: reply.value.grantId };
}

/** Moves the stage without dispatching anything (for example, after a result was received). The database checks the transition. */
export async function setStageInTx(client: TenantQueryable, executionId: string, stage: string): Promise<void> {
  await client.query('UPDATE aegis.agent_executions SET workflow_stage = $2, updated_at = clock_timestamp() WHERE execution_id = $1',
    [executionId, stage]);
}

/**
 * Compatibility entry for the P5 messaging tests and the synthetic acceptance CLI: one step in its own transaction against a pool.
 * Production orchestration calls dispatchStepInTx inside the receive transaction.
 */
export async function delegateAndDispatch(pool: Pool, hooks: ExecutionHooks, input: StepInput): Promise<StepOutcome> {
  return withMessagingContext(pool, { tenantId: input.tenantId }, (client) => dispatchStepInTx(client, hooks, input));
}

export type { PoolClient };

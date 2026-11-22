import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { createAgentExecutionStore, joinTransaction, type ExecutionHooks, type Fence } from '../persistence/execution-store.js';
import { argumentsDigest } from '../delegation.js';
import { enqueueMessage } from './outbox.js';
import { buildWireMessage, payloadDigest } from './wire.js';
import { withMessagingContext } from './context.js';

/**
 * The deterministic, read-only workflow P5 demonstrates: the orchestrator asks the triage agent to classify a case's document presence,
 * and triage returns a result. Nothing here calls an external system, a model or a tool. The triage effect is a pure function of the
 * authorised arguments. It is a demonstration of durable, authenticated messaging, not a triage capability.
 */

export const ROOT_AGENT = 'orchestrator';
export const TRIAGE_AGENT = 'triage';
export const ACTION_REQUEST = 'triage.classify';
export const ACTION_RESULT = 'triage.result';
export const WORKFLOW_SCOPES = ['document:read'] as const;

export interface TriageArguments {
  readonly caseRef: string;
  readonly documentCount: number;
  readonly questionCode: 'status_check';
}

export interface TriageResult {
  readonly verdict: 'documents_present' | 'no_documents';
  readonly documentCount: number;
  readonly questionCode: 'status_check';
}

/** Pure, read-only classification. The result depends only on the authorised arguments. */
export function triageEffect(args: TriageArguments): TriageResult {
  return { verdict: args.documentCount > 0 ? 'documents_present' : 'no_documents', documentCount: args.documentCount,
    questionCode: args.questionCode };
}

/** Narrows an untrusted argument object to the typed shape. Anything else is refused, and the caller records it. */
export function parseTriageArguments(value: unknown): TriageArguments | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  const keys = Object.keys(v).sort().join(',');
  if (keys !== 'caseRef,documentCount,questionCode') return null;
  if (typeof v.caseRef !== 'string' || !/^[0-9a-f-]{36}$/i.test(v.caseRef)) return null;
  if (!Number.isInteger(v.documentCount) || (v.documentCount as number) < 0 || (v.documentCount as number) > 100) return null;
  if (v.questionCode !== 'status_check') return null;
  return { caseRef: v.caseRef, documentCount: v.documentCount as number, questionCode: 'status_check' };
}

export interface DelegateAndDispatchInput {
  readonly tenantId: string;
  readonly fence: Fence;
  readonly to: string;
  readonly requestedScopes: readonly string[];
  readonly action: string;
  readonly resultAction: string;
  readonly arguments: TriageArguments;
  readonly maxAttempts?: number;
}

export type DelegateOutcome =
  | { readonly ok: true; readonly delegationSeq: number; readonly requestMessageId: string; readonly resultGrantId: string }
  | { readonly ok: false; readonly reason: string };

/**
 * One P4 decision that also produces its outbound message. The delegation, both grants (the request grant and the return grant for
 * the result), the request message and the lease release all commit in one transaction. If any step refuses, the savepoint is rolled
 * back, so no delegation, grant or message is left behind, and only the refusal is recorded.
 */
export async function delegateAndDispatch(pool: Pool, hooks: ExecutionHooks, input: DelegateAndDispatchInput): Promise<DelegateOutcome> {
  const digest = argumentsDigest(input.arguments as unknown as Record<string, unknown>);
  return withMessagingContext(pool, { tenantId: input.tenantId, agentId: input.fence.agentId }, async (client) => {
    const store = createAgentExecutionStore(joinTransaction(client, input.tenantId), hooks);
    await client.query('SAVEPOINT p5_decision', []);
    const refuse = async (eventType: string, reason: string): Promise<DelegateOutcome> => {
      await client.query('ROLLBACK TO SAVEPOINT p5_decision', []);
      await client.query(
        `INSERT INTO aegis.agent_execution_events (tenant_id, execution_id, event_type, outcome, reason, actor_agent, actor_instance, fencing_token)
         VALUES ($1, $2, $3, 'refused', $4, $5, $6, $7)`,
        [input.tenantId, input.fence.executionId, eventType, reason, input.fence.agentId, input.fence.instance, input.fence.fencingToken]);
      return { ok: false, reason };
    };

    const delegated = await store.recordDelegation(input.fence, { parentSeq: null, to: input.to, requestedScopes: input.requestedScopes });
    if (!delegated.ok) return refuse('delegation_refused', delegated.reason);

    const chain = await client.query<{ chain_digest: string; depth: number }>(
      'SELECT chain_digest, depth FROM aegis.agent_delegations WHERE execution_id = $1 AND seq = $2',
      [input.fence.executionId, delegated.value.seq]);
    const hop = chain.rows[0];
    if (!hop) return refuse('delegation_refused', 'discontinuous_chain');

    const request = await store.issueGrant(input.fence, { chainSeq: delegated.value.seq, kind: 'request', action: input.action,
      argumentsDigest: digest, requiredScopes: [...input.requestedScopes] });
    if (!request.ok) return refuse('grant_refused', request.reason);

    const returning = await store.issueGrant(input.fence, { chainSeq: delegated.value.seq, kind: 'result', direction: 'return',
      action: input.resultAction, argumentsDigest: digest, requiredScopes: [...input.requestedScopes] });
    if (!returning.ok) return refuse('grant_refused', returning.reason);

    const execution = await client.query<{ principal_ref: string }>(
      'SELECT principal_ref FROM aegis.agent_executions WHERE execution_id = $1', [input.fence.executionId]);
    const principalRef = execution.rows[0]?.principal_ref;
    if (!principalRef) return refuse('grant_refused', 'not_found');

    const payload = { arguments: { ...input.arguments } } as Record<string, unknown>;
    const messageId = randomUUID();
    const wire = buildWireMessage({ messageId, tenantId: input.tenantId, executionId: input.fence.executionId, kind: 'request', payload,
      envelope: { kind: 'request', executionId: input.fence.executionId, tenantId: input.tenantId, principalRef,
        from: input.fence.agentId, to: input.to, depth: hop.depth, chainDigest: hop.chain_digest, action: input.action,
        argumentsDigest: digest } });
    await enqueueMessage(client, { messageId, tenantId: input.tenantId, executionId: input.fence.executionId, sender: input.fence.agentId,
      destination: input.to, kind: 'request', envelope: wire.envelope, payload: wire.payload, payloadDigest: payloadDigest(payload),
      maxAttempts: input.maxAttempts ?? 6 });

    const released = await store.release(input.fence, 'pending', 'dispatched');
    if (!released.ok) return refuse('fenced_write_refused', released.reason);

    return { ok: true, delegationSeq: delegated.value.seq, requestMessageId: messageId, resultGrantId: returning.value.grantId };
  });
}


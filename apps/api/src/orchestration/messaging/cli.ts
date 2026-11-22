import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import { createDatabasePool, verifyRuntimeRole } from '../../storage/database.js';
import { createAgentExecutionStore, type ExecutionHooks } from '../persistence/execution-store.js';
import { createExecutionTelemetry } from '../persistence/execution-telemetry.js';
import type { TenantRunner } from '../../security/tool-approval-store.js';
import { withMessagingContext } from './context.js';
import { ACTION_REQUEST, ACTION_RESULT, TRIAGE_AGENT, WORKFLOW_SCOPES, delegateAndDispatch, type TriageArguments } from './workflow.js';
import { purgeDelivered, requeueDeadMessage } from './outbox.js';
import { createMessagingTelemetry } from './telemetry.js';

/**
 * Operator and workflow commands. They run inside the orchestrator runtime's network namespace, so they reach PostgreSQL the same way the
 * runtime does, and the orchestrator identity they act as is the one its proxy verified.
 *
 *   start      create (or resume, by idempotency key) a tenant-bound execution and dispatch the triage request
 *   status     show the execution, its messages, inbox receipts and audit (bounded fields only)
 *   dead       list dead-lettered messages for a tenant
 *   requeue    operator action: requeue one dead message with a bounded new budget, audited
 *   purge      retention: delete delivered messages older than a cutoff, for one tenant
 */

const args = process.argv.slice(2);
const command = args[0];
const flag = (name: string): string | undefined => {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? undefined : args[index + 1];
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const sha = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');

function requireUuid(name: string): string {
  const value = flag(name);
  if (!value || !UUID.test(value)) throw new Error(`--${name} must be a UUID`);
  return value;
}

const pool: Pool = createDatabasePool(process.env.DATABASE_URL ?? '', 4);
const runTenant: TenantRunner = (tenantId, operation) => withMessagingContext(pool, { tenantId, agentId: 'orchestrator' }, operation);

async function identity(): Promise<string> {
  const response = await fetch(`${process.env.AEGIS_PROXY_IDENTITY_URL ?? 'http://127.0.0.1:7002'}/v1/identity`, { signal: AbortSignal.timeout(3000) });
  const body = await response.json() as { spiffeId?: string };
  if (!body.spiffeId) throw new Error('no identity');
  return body.spiffeId;
}

async function start(): Promise<unknown> {
  const tenantId = requireUuid('tenant');
  const caseRef = requireUuid('case');
  const documentCount = Number(flag('document-count') ?? '1');
  const principal = flag('principal') ?? 'acceptance-operator';
  const hooks: ExecutionHooks = { onDecision: createExecutionTelemetry().onDecision };
  const spiffeId = await identity();
  const store = createAgentExecutionStore(runTenant, hooks);
  const principalRef = sha(`principal:${principal}`);
  const created = await store.createExecution({ tenantId, idempotencyKey: `p5-workflow:${caseRef}`, principalRef,
    principalScopes: ['case:read', 'document:read'], limits: { maxDepth: 3, maxDelegations: 4, maxSteps: 8 }, grantTtlSeconds: 300, maxAttempts: 5 });
  const claim = await store.claim({ tenantId, executionId: created.executionId, spiffeId, instance: 'workflow-cli', leaseSeconds: 60 });
  if (!claim.ok) return { status: 'refused', stage: 'claim', reason: claim.reason, executionId: created.executionId };
  const triage: TriageArguments = { caseRef, documentCount, questionCode: 'status_check' };
  const maxAttempts = Number(flag('max-attempts') ?? '6');
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 10) throw new Error('--max-attempts must be 1..10');
  const dispatched = await delegateAndDispatch(pool, hooks, { tenantId, fence: { tenantId, executionId: created.executionId,
    agentId: claim.value.agentId, instance: 'workflow-cli', fencingToken: claim.value.fencingToken }, to: TRIAGE_AGENT,
  requestedScopes: [...WORKFLOW_SCOPES], action: ACTION_REQUEST, resultAction: ACTION_RESULT, arguments: triage, maxAttempts });
  if (!dispatched.ok) return { status: 'refused', stage: 'dispatch', reason: dispatched.reason, executionId: created.executionId };
  return { status: 'dispatched', executionId: created.executionId, requestMessageId: dispatched.requestMessageId,
    created: created.created, delegationSeq: dispatched.delegationSeq };
}

async function status(): Promise<unknown> {
  const tenantId = requireUuid('tenant');
  const executionId = requireUuid('execution');
  return withMessagingContext(pool, { tenantId }, async (client) => {
    const execution = await client.query<{ status: string; fencing_token: string; steps_taken: number; delegations_issued: number }>(
      'SELECT status, fencing_token::text AS fencing_token, steps_taken, delegations_issued FROM aegis.agent_executions WHERE execution_id = $1', [executionId]);
    const messages = await client.query<{ message_id: string; kind: string; sender_agent: string; destination_agent: string; status: string;
      attempts: number; dead_reason: string | null; last_error: string | null }>(
      `SELECT message_id, kind, sender_agent, destination_agent, status, attempts, dead_reason, last_error
         FROM aegis.agent_outbox WHERE execution_id = $1 ORDER BY created_at, message_id`, [executionId]);
    const inbox = await client.query<{ receiver_agent: string; outcome: string; refusal_reason: string | null }>(
      'SELECT receiver_agent, outcome, refusal_reason FROM aegis.agent_inbox WHERE execution_id = $1 ORDER BY received_at', [executionId]);
    const events = await client.query<{ event_type: string; outcome: string; reason: string | null }>(
      'SELECT event_type, outcome, reason FROM aegis.agent_execution_events WHERE execution_id = $1 ORDER BY event_id', [executionId]);
    return { execution: execution.rows[0] ?? null, messages: messages.rows, inbox: inbox.rows, executionEvents: events.rows };
  });
}

async function dead(): Promise<unknown> {
  const tenantId = requireUuid('tenant');
  return withMessagingContext(pool, { tenantId }, async (client) => (await client.query<{ message_id: string; execution_id: string;
    sender_agent: string; destination_agent: string; dead_reason: string | null; attempts: number }>(
    `SELECT message_id, execution_id, sender_agent, destination_agent, dead_reason, attempts FROM aegis.agent_outbox
      WHERE status = 'dead' ORDER BY dead_at`, [])).rows);
}

async function requeue(): Promise<unknown> {
  const tenantId = requireUuid('tenant');
  const messageId = requireUuid('message');
  const operator = flag('operator');
  const reason = flag('reason') ?? '';
  const budget = Number(flag('budget') ?? '3');
  if (!operator || !/^[a-z_]{1,40}$/.test(reason) || !Number.isInteger(budget) || budget < 1 || budget > 10) {
    throw new Error('requeue needs --operator, --reason (lowercase, underscores) and --budget 1..10');
  }
  const done = await withMessagingContext(pool, { tenantId }, (client) => requeueDeadMessage(client, { tenantId, messageId,
    operatorRef: sha(`operator:${operator}`), reason, budget }));
  if (done) createMessagingTelemetry().requeues();
  return { requeued: done, messageId };
}

async function purge(): Promise<unknown> {
  const tenantId = requireUuid('tenant');
  const hours = Number(flag('older-than-hours') ?? '168');
  if (!Number.isInteger(hours) || hours < 1) throw new Error('--older-than-hours must be a positive integer');
  const deleted = await withMessagingContext(pool, { tenantId }, (client) => purgeDelivered(client, tenantId, hours));
  return { deleted };
}

async function main(): Promise<void> {
  await verifyRuntimeRole(pool);
  const handlers: Record<string, () => Promise<unknown>> = { start, status, dead, requeue, purge };
  const handler = command ? handlers[command] : undefined;
  if (!handler) {
    process.stderr.write('usage: cli.js start|status|dead|requeue|purge [flags]\n');
    process.exitCode = 2;
    return;
  }
  try {
    process.stdout.write(`${JSON.stringify(await handler())}\n`);
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${JSON.stringify({ event: 'cli_error', error: error instanceof Error ? error.message : 'error' })}\n`);
  process.exitCode = 1;
  void pool.end();
});

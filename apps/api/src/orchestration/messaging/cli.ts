import { Pool } from 'pg';
import { createDatabasePool } from '../../storage/database.js';
import { requeueDeadMessage, purgeDelivered } from './outbox.js';
import { withMessagingContext } from './context.js';
import { createMessagingTelemetry } from './telemetry.js';
import { submitInvestigation, type Principal } from '../../investigation/gateway.js';
import { createHash } from 'node:crypto';
import { randomUUID } from 'node:crypto';

/**
 * Operator and acceptance commands. Each runs under its own database role, so no command can do another's work:
 *   status     the execution, its stage, messages and audit for one tenant (orchestrator role, read-only use)
 *   dead       dead-lettered messages for one tenant (operator role)
 *   requeue    operator action: requeue one dead message with a bounded new budget, audited (operator role)
 *   purge      operator retention: delete delivered messages older than a cutoff (operator role)
 *   submit     SYNTHETIC ACCEPTANCE ONLY. Submits an investigation through the gateway role for a synthetic principal. It requires
 *              --synthetic-acceptance and the synthetic issuer, and it cannot be used for authenticated operation (use the API).
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

function poolFrom(envName: string): Pool {
  const url = process.env[envName];
  if (!url) throw new Error(`${envName} is required for this command`);
  return createDatabasePool(url, 2);
}

async function dead(pool: Pool): Promise<unknown> {
  const tenantId = requireUuid('tenant');
  return withMessagingContext(pool, { tenantId }, async (client) => (await client.query<{ message_id: string; execution_id: string;
    sender_agent: string; destination_agent: string; dead_reason: string | null; attempts: number }>(
    `SELECT message_id, execution_id, sender_agent, destination_agent, dead_reason, attempts FROM aegis.agent_outbox
      WHERE status = 'dead' ORDER BY dead_at`, [])).rows);
}

async function requeue(pool: Pool): Promise<unknown> {
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

async function purge(pool: Pool): Promise<unknown> {
  const tenantId = requireUuid('tenant');
  const hours = Number(flag('older-than-hours') ?? '168');
  if (!Number.isInteger(hours) || hours < 1) throw new Error('--older-than-hours must be a positive integer');
  const deleted = await withMessagingContext(pool, { tenantId }, (client) => purgeDelivered(client, tenantId, hours));
  return { deleted };
}

async function status(pool: Pool): Promise<unknown> {
  const tenantId = requireUuid('tenant');
  const executionId = requireUuid('execution');
  return withMessagingContext(pool, { tenantId }, async (client) => {
    const execution = await client.query('SELECT status, workflow_stage, fencing_token::text AS fencing_token, steps_taken, delegations_issued FROM aegis.agent_executions WHERE execution_id = $1', [executionId]);
    const messages = await client.query('SELECT kind, sender_agent, destination_agent, status, attempts, dead_reason FROM aegis.agent_outbox WHERE execution_id = $1 ORDER BY created_at, message_id', [executionId]);
    const inbox = await client.query('SELECT receiver_agent, outcome, refusal_reason FROM aegis.agent_inbox WHERE execution_id = $1 ORDER BY received_at', [executionId]);
    return { execution: execution.rows[0] ?? null, messages: messages.rows, inbox: inbox.rows };
  });
}

async function submit(): Promise<unknown> {
  if (!args.includes('--synthetic-acceptance')) throw new Error('submit is for synthetic acceptance only; use the authenticated API');
  const tenantId = requireUuid('tenant');
  const question = flag('question') ?? '';
  const subject = flag('subject') ?? 'synthetic-acceptance-user';
  const principal: Principal = { issuer: 'synthetic-acceptance', subject, scopes: new Set(['read:cases']) };
  const pool = poolFrom('DATABASE_GATEWAY_URL');
  try {
    const run = (tenant: string, op: never) => withMessagingContext(pool, { tenantId: tenant }, op);
    return await submitInvestigation(run as never, principal, { tenantId, idempotencyKey: flag('idempotency-key') ?? randomUUID(), question });
  } finally {
    await pool.end();
  }
}

async function main(): Promise<void> {
  const commands: Record<string, () => Promise<unknown>> = {
    status: async () => { const p = poolFrom('DATABASE_URL'); try { return await status(p); } finally { await p.end(); } },
    dead: async () => { const p = poolFrom('DATABASE_OPERATOR_URL'); try { return await dead(p); } finally { await p.end(); } },
    requeue: async () => { const p = poolFrom('DATABASE_OPERATOR_URL'); try { return await requeue(p); } finally { await p.end(); } },
    purge: async () => { const p = poolFrom('DATABASE_OPERATOR_URL'); try { return await purge(p); } finally { await p.end(); } },
    submit,
  };
  const handler = command ? commands[command] : undefined;
  if (!handler) {
    process.stderr.write('usage: cli.js status|dead|requeue|purge|submit [flags]\n');
    process.exitCode = 2;
    return;
  }
  process.stdout.write(`${JSON.stringify(await handler())}\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`${JSON.stringify({ event: 'cli_error', error: error instanceof Error ? error.message : 'error' })}\n`);
  process.exitCode = 1;
});

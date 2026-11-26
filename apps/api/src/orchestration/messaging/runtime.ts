import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createDatabasePool } from '../../storage/database.js';
import { createExecutionTelemetry } from '../persistence/execution-telemetry.js';
import type { ExecutionHooks } from '../persistence/execution-store.js';
import { dispatchOnce, sampleBacklog } from './dispatcher.js';
import { receiveMessage } from './inbox.js';
import { verifyAgentRole, withMessagingContext } from './context.js';
import { startInvestigationInTx } from './handlers.js';
import { reconcileCancellations } from './cancellation.js';
import { createMessagingTelemetry } from './telemetry.js';
import { MAX_BODY_BYTES } from './wire.js';

/**
 * One agent runtime process: the P5 dispatcher and inbox for one registered agent. It runs in the network namespace of its agent proxy
 * (see docs/P5-TRANSACTIONAL-MESSAGING.md), so its only network peers are the proxy's loopback listeners:
 * - egress (outbound): POST /v1/deliver, which performs the mTLS to the destination;
 * - identity: GET /v1/identity, which returns the SPIFFE ID the proxy verified with the Workload API;
 * - inbox (inbound): this process listens on loopback only, and the proxy forwards verified peers with x-aegis-peer-spiffe-id.
 *
 * The runtime refuses to start unless the identity its proxy reports is the registration of AEGIS_AGENT_ID. No value from the
 * environment or from a message names the sender.
 */

const env = process.env;
const agentId = env.AEGIS_AGENT_ID ?? '';
const egressUrl = env.AEGIS_PROXY_EGRESS_URL ?? 'http://127.0.0.1:7001';
const identityUrl = env.AEGIS_PROXY_IDENTITY_URL ?? 'http://127.0.0.1:7002';
const [inboxHost, inboxPortText] = (env.AEGIS_INBOX_LISTEN ?? '127.0.0.1:7100').split(':');
const dispatchIntervalMs = Number(env.AEGIS_DISPATCH_INTERVAL_MS ?? 200);
const batchSize = Number(env.AEGIS_DISPATCH_BATCH ?? 8);
const leaseSeconds = Number(env.AEGIS_LEASE_SECONDS ?? 30);
const deliveryTimeoutMs = Number(env.AEGIS_DELIVERY_TIMEOUT_MS ?? 5000);

const log = (event: string, fields: Record<string, unknown> = {}) => {
  process.stdout.write(`${JSON.stringify({ event, agent: agentId, ...fields })}\n`);
};

const AGENTS = ['orchestrator', 'triage', 'retrieval', 'reviewer'] as const;

export function assertAgentId(value: string): void {
  if (!(AGENTS as readonly string[]).includes(value)) throw new Error('AEGIS_AGENT_ID must name a registered agent');
}

async function fetchIdentity(): Promise<string> {
  for (let attempt = 1; attempt <= 60; attempt += 1) {
    try {
      const response = await fetch(`${identityUrl}/v1/identity`, { signal: AbortSignal.timeout(2000) });
      if (response.ok) {
        const body = await response.json() as { spiffeId?: unknown };
        if (typeof body.spiffeId === 'string') return body.spiffeId;
      }
    } catch { /* proxy not ready yet */ }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error('agent proxy did not report an identity');
}

async function readBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES + 512) throw new RangeError('body too large');
    chunks.push(chunk as Buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
}

function send(response: ServerResponse, status: number, body: Record<string, unknown>): void {
  response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  response.end(JSON.stringify(body));
}

async function main(): Promise<void> {
  assertAgentId(agentId);
  const pool = createDatabasePool(env.DATABASE_URL ?? '', 6);
  await verifyAgentRole(pool, agentId);

  const spiffeId = await fetchIdentity();
  const registered = await pool.query<{ agent_id: string }>(
    `SELECT agent_id FROM aegis.agent_registrations WHERE spiffe_id = $1 AND status = 'active'`, [spiffeId]);
  if (registered.rows[0]?.agent_id !== agentId) {
    log('identity_refused', { reason: 'not_registered_for_agent' });
    process.exit(1);
  }
  log('runtime_started', { spiffeId });

  const executionTelemetry = createExecutionTelemetry();
  const hooks: ExecutionHooks = { onDecision: (d) => executionTelemetry.onDecision(d) };
  const telemetry = createMessagingTelemetry();
  const instance = `${agentId}-${process.pid}`;
  let stopping = false;

  const server = createServer(async (request, response) => {
    if (request.method === 'GET' && request.url === '/healthz') return send(response, 200, { status: 'ok' });
    const match = /^\/v1\/inbox\/([0-9a-f-]{36})$/i.exec(request.url ?? '');
    if (request.method !== 'POST' || !match) return send(response, 404, { status: 'not_found' });
    const peer = request.headers['x-aegis-peer-spiffe-id'];
    if (typeof peer !== 'string' || peer.length === 0) return send(response, 403, { status: 'refused', reason: 'unknown_peer' });
    let body: unknown;
    try {
      body = await readBody(request);
    } catch {
      return send(response, 422, { status: 'refused', reason: 'malformed' });
    }
    try {
      const result = await receiveMessage(pool, hooks, { receiver: agentId, peerSpiffeId: peer, messageId: match[1].toLowerCase(), body,
        orchestrator: agentId === 'orchestrator' ? { spiffeId, instance } : undefined });
      telemetry.inboxDecision(result.status, result.reason, agentId);
      if (result.status === 'duplicate') telemetry.duplicates(agentId);
      log('inbox_decision', { messageId: match[1], status: result.status, reason: result.reason });
      return send(response, result.httpStatus, { status: result.status, reason: result.reason, resultMessageId: result.resultMessageId,
        resultDigest: result.resultDigest });
    } catch (error) {
      log('inbox_error', { messageId: match[1], error: error instanceof Error ? error.name : 'error' });
      return send(response, 503, { status: 'transient', reason: 'internal' });
    }
  });
  server.listen(Number(inboxPortText ?? 7100), inboxHost ?? '127.0.0.1');

  const dispatchLoop = async () => {
    while (!stopping) {
      try {
        const summary = await dispatchOnce({ pool, agentId, instance, egressUrl, leaseSeconds, batchSize, deliveryTimeoutMs, telemetry });
        if (summary.claimed > 0) log('dispatch_cycle', { ...summary });
      } catch (error) {
        log('dispatch_error', { error: error instanceof Error ? error.name : 'error' });
      }
      await new Promise((resolve) => setTimeout(resolve, dispatchIntervalMs));
    }
  };
  // Orchestrator intake: starts submitted investigations. Restart-safe: an execution is started only by a committed transaction, so a
  // restarted orchestrator finds the same submitted executions and starts the ones that were not started yet.
  const intakeLoop = async () => {
    while (!stopping && agentId === 'orchestrator') {
      try {
        const candidates = await pool.query<{ tenant_id: string; execution_id: string }>('SELECT tenant_id, execution_id FROM aegis.orchestrator_intake($1)', [10]);
        for (const row of candidates.rows) {
          const outcome = await withMessagingContext(pool, { tenantId: row.tenant_id }, (client) => startInvestigationInTx(client, hooks,
            { tenantId: row.tenant_id, executionId: row.execution_id, orchestrator: { spiffeId, instance } }));
          log('intake_decision', { executionId: row.execution_id, outcome });
        }
      } catch (error) {
        log('intake_error', { error: error instanceof Error ? error.name : 'error' });
      }
      await new Promise((resolve) => setTimeout(resolve, dispatchIntervalMs));
    }
  };
  // Orchestrator-owned cancellation: finalises requested cancellations that no reply will ever finalise. Bounded per cycle, and idempotent:
  // a finalised execution is terminal, so it is not rediscovered. A crash loses nothing: the request flag is committed in the database.
  const cancellationLoop = async () => {
    while (!stopping && agentId === 'orchestrator') {
      try {
        const summary = await reconcileCancellations(pool, hooks, { instance, limit: 10 });
        if (summary.applied > 0 || summary.refused > 0) log('cancellation_reconciled', { ...summary });
      } catch (error) {
        log('cancellation_error', { error: error instanceof Error ? error.name : 'error' });
      }
      await new Promise((resolve) => setTimeout(resolve, dispatchIntervalMs));
    }
  };
  const sampleLoop = async () => {
    while (!stopping) {
      try { await sampleBacklog(pool, agentId, telemetry); } catch { /* sampling never stops dispatch */ }
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }
  };
  void dispatchLoop();
  void sampleLoop();
  void intakeLoop();
  void cancellationLoop();

  const shutdown = () => {
    stopping = true;
    server.close();
    setTimeout(() => process.exit(0), 1000).unref();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

if (process.argv[1] && process.argv[1].endsWith('runtime.js')) {
  main().catch((error: unknown) => {
    log('runtime_stopped', { error: error instanceof Error ? error.name : 'error' });
    process.exit(1);
  });
}

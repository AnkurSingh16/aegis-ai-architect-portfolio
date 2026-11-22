import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import { createServer, type Server } from 'node:http';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import { createDatabasePool } from '../../../storage/database.js';
import { receiveMessage, type ReceiveResult } from '../inbox.js';
import { startInvestigationInTx } from '../handlers.js';
import { withMessagingContext } from '../context.js';
import { ROOT_AGENT, TRIAGE_AGENT } from '../workflow.js';
import { submitInvestigation, type Principal } from '../../../investigation/gateway.js';
import type { TenantQueryable } from '../../../security/tool-approval-store.js';
import type { ExecutionHooks } from '../../persistence/execution-store.js';

// Shared helpers for P5 and P8 integration tests. Test code only. Each agent acts through its own database role, as in production.

export const CHILD = fileURLToPath(new URL('./messaging-child.ts', import.meta.url));
export const SPIFFE = {
  orchestrator: 'spiffe://aegis.local/workload/orchestrator',
  triage: 'spiffe://aegis.local/workload/triage',
  retrieval: 'spiffe://aegis.local/workload/retrieval',
  reviewer: 'spiffe://aegis.local/workload/reviewer',
  unregistered: 'spiffe://aegis.local/workload/probe',
} as const;
export const NORTH = '10000000-0000-4000-8000-000000000001';
export const SOUTH = '20000000-0000-4000-8000-000000000002';
export const TEST_ISSUER = 'test-issuer';
export const QUESTION = 'Which synthetic procedure applies to an account recovery request document?';
export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
export const principalDigest = (label: string) => createHash('sha256').update(`synthetic-principal:${label}`).digest('hex');

export type AgentName = 'orchestrator' | 'triage' | 'retrieval' | 'reviewer';
export const ROLE_VARIABLE: Record<AgentName | 'gateway' | 'operator', string> = {
  orchestrator: 'TEST_ROLE_URL_ORCHESTRATOR', triage: 'TEST_ROLE_URL_TRIAGE', retrieval: 'TEST_ROLE_URL_RETRIEVAL',
  reviewer: 'TEST_ROLE_URL_REVIEWER', gateway: 'TEST_ROLE_URL_GATEWAY', operator: 'TEST_ROLE_URL_OPERATOR',
};

export function requireEnv(): { adminUrl: string; runtimeUrl: string } {
  const adminUrl = process.env.TEST_DATABASE_ADMIN_URL;
  const runtimeUrl = process.env.TEST_DATABASE_URL;
  if (!adminUrl || !runtimeUrl) throw new Error('Set TEST_DATABASE_ADMIN_URL and TEST_DATABASE_URL for real PostgreSQL tests.');
  return { adminUrl, runtimeUrl };
}

export function roleUrl(role: AgentName | 'gateway' | 'operator'): string {
  const url = process.env[ROLE_VARIABLE[role]];
  if (!url) throw new Error(`Set ${ROLE_VARIABLE[role]} (the workload role's test URL) for real PostgreSQL tests.`);
  return url;
}

export interface WorkerHandle {
  readonly child: ChildProcess;
  waitForEvent(name: string, timeoutMs?: number): Promise<Record<string, unknown>>;
  exited(): Promise<{ code: number | null; signal: NodeJS.Signals | null; events: Array<Record<string, unknown>> }>;
  kill(): void;
}

/** Starts one messaging worker process as a workload role. */
export function spawnMessagingWorker(args: Record<string, unknown>): WorkerHandle {
  const child = spawn(process.execPath, ['--import', 'tsx', CHILD, JSON.stringify(args)], { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
  const events: Array<Record<string, unknown>> = [];
  const waiters: Array<{ name: string; resolve: (e: Record<string, unknown>) => void }> = [];
  const lines = createInterface({ input: child.stdout! });
  lines.on('line', (line) => {
    let parsed: Record<string, unknown>;
    try { parsed = JSON.parse(line) as Record<string, unknown>; } catch { return; }
    events.push(parsed);
    for (const waiter of waiters.filter((w) => w.name === parsed.event)) waiter.resolve(parsed);
  });
  const done = new Promise<{ code: number | null; signal: NodeJS.Signals | null; events: Array<Record<string, unknown>> }>((resolve) => {
    child.on('exit', (code, signal) => resolve({ code, signal, events }));
  });
  return {
    child,
    waitForEvent(name, timeoutMs = 30000) {
      const existing = events.find((e) => e.event === name);
      if (existing) return Promise.resolve(existing);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`timed out waiting for ${name}`)), timeoutMs);
        waiters.push({ name, resolve: (e) => { clearTimeout(timer); resolve(e); } });
      });
    },
    exited: () => done,
    kill: () => child.kill('SIGKILL'),
  };
}

/**
 * A stand-in for one agent's egress proxy, in-process. It chooses the verified peer identity (the proxy's job in production); the
 * inbox, the handlers and the database checks are the real ones, each reached through the receiver's own role.
 */
export interface StubEgress {
  readonly url: string;
  readonly deliveries: Array<{ messageId: string; destination: string; status: number }>;
  mode: 'deliver' | 'unavailable' | 'refuse_identity' | 'deliver_lose_ack';
  close(): Promise<void>;
}

export async function startStubEgress(sender: AgentName, pools: Record<AgentName, Pool>, hooks: ExecutionHooks = {}): Promise<StubEgress> {
  const deliveries: Array<{ messageId: string; destination: string; status: number }> = [];
  const state: { mode: StubEgress['mode'] } = { mode: 'deliver' };
  const server: Server = createServer((request, response) => {
    if (request.method !== 'POST' || request.url !== '/v1/deliver') { response.writeHead(404).end(); return; }
    const chunks: Buffer[] = [];
    request.on('data', (c: Buffer) => chunks.push(c));
    request.on('end', () => {
      void (async () => {
        const destination = String(request.headers['x-aegis-destination'] ?? '') as AgentName;
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { messageId: string };
        const send = (status: number, json: Record<string, unknown>) => {
          deliveries.push({ messageId: body.messageId, destination, status });
          response.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(json));
        };
        if (state.mode === 'unavailable') return send(503, { status: 'transient', reason: 'receiver_unavailable' });
        if (state.mode === 'refuse_identity') return send(403, { status: 'refused', reason: 'peer_identity_refused' });
        if (!(destination in pools)) return send(404, { status: 'refused', reason: 'unknown_destination' });
        const result: ReceiveResult = await receiveMessage(pools[destination], hooks, { receiver: destination, peerSpiffeId: SPIFFE[sender],
          messageId: body.messageId, body, orchestrator: destination === ROOT_AGENT ? { spiffeId: SPIFFE.orchestrator, instance: 'test' } : undefined });
        if (state.mode === 'deliver_lose_ack') return send(503, { status: 'transient', reason: 'ack_lost' });
        send(result.httpStatus, { status: result.status, reason: result.reason, resultMessageId: result.resultMessageId, resultDigest: result.resultDigest });
      })();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}`,
    deliveries,
    get mode() { return state.mode; },
    set mode(value: StubEgress['mode']) { state.mode = value; },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  } as StubEgress;
}

export interface Harness {
  readonly adminPool: Pool;
  readonly pools: Record<AgentName | 'gateway' | 'operator', Pool>;
  readonly pool: Pool;
  readonly tenantA: string;
  readonly tenantB: string;
}

/** One pool per workload role. The admin pool is for setup and assertions only. */
export async function createHarness(options: { tenants?: [string, string] } = {}): Promise<Harness> {
  const { adminUrl } = requireEnv();
  const adminPool = new Pool({ connectionString: adminUrl, max: 2, connectionTimeoutMillis: 30000 });
  adminPool.on('error', () => undefined);
  const make = (url: string, max = 6) => { const p = createDatabasePool(url, max); p.on('error', () => undefined); return p; };
  const pools = {
    orchestrator: make(roleUrl('orchestrator')), triage: make(roleUrl('triage')), retrieval: make(roleUrl('retrieval')),
    reviewer: make(roleUrl('reviewer')), gateway: make(roleUrl('gateway')), operator: make(roleUrl('operator')),
  };
  const [tenantA, tenantB] = options.tenants ?? [NORTH, SOUTH];
  await adminPool.query(`INSERT INTO aegis.tenants (id, name) VALUES ($1, 'Synthetic North'), ($2, 'Synthetic South') ON CONFLICT (id) DO NOTHING`, [tenantA, tenantB]);
  await adminPool.query(`INSERT INTO aegis.memberships (issuer, subject, tenant_id, role) VALUES ($1, 'test-reader', $2, 'reader'),
    ($1, 'test-reader', $3, 'reader') ON CONFLICT DO NOTHING`, [TEST_ISSUER, tenantA, tenantB]);
  return { adminPool, pools, pool: pools.orchestrator, tenantA, tenantB };
}

export async function closeHarness(h: Harness): Promise<void> {
  for (const p of Object.values(h.pools)) await p.end();
  await h.adminPool.end();
}

export const readerPrincipal = (subject = 'test-reader'): Principal => ({ issuer: TEST_ISSUER, subject, scopes: new Set(['read:cases']) });

/** Submits through the gateway, then starts the investigation through the orchestrator's intake transaction. */
export async function startInvestigation(h: Harness, options: { tenantId?: string; question?: string; subject?: string } = {}):
  Promise<{ executionId: string; tenantId: string; requestMessageId: string }> {
  const tenantId = options.tenantId ?? h.tenantA;
  const run = (tenant: string, op: (client: TenantQueryable) => Promise<unknown>) => withMessagingContext(h.pools.gateway, { tenantId: tenant }, op as never);
  const submitted = await submitInvestigation(run as never, readerPrincipal(options.subject), { tenantId, idempotencyKey: randomUUID(),
    question: options.question ?? QUESTION });
  const outcome = await withMessagingContext(h.pools.orchestrator, { tenantId }, (client) => startInvestigationInTx(client, {}, {
    tenantId, executionId: submitted.executionId, orchestrator: { spiffeId: SPIFFE.orchestrator, instance: 'test' } }));
  if (outcome !== 'started') throw new Error(`intake did not start the investigation: ${outcome}`);
  const request = (await h.adminPool.query<{ message_id: string }>(
    `SELECT message_id FROM aegis.agent_outbox WHERE execution_id = $1 AND sender_agent = 'orchestrator' ORDER BY created_at LIMIT 1`,
    [submitted.executionId])).rows[0];
  return { executionId: submitted.executionId, tenantId, requestMessageId: request.message_id };
}

/** The wire body of a message, as the sending runtime would send it. Read with the admin pool (test assertion path). */
export async function wireOf(h: Harness, messageId: string): Promise<Record<string, unknown>> {
  const row = (await h.adminPool.query<{ tenant_id: string; execution_id: string; kind: string; envelope: unknown; payload: unknown; payload_digest: string }>(
    'SELECT tenant_id, execution_id, kind, envelope, payload, payload_digest FROM aegis.agent_outbox WHERE message_id = $1', [messageId])).rows[0];
  return { schemaVersion: 1, messageId, tenantId: row.tenant_id, executionId: row.execution_id, kind: row.kind, envelope: row.envelope,
    payload: row.payload, payloadDigest: row.payload_digest };
}

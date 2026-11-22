import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import { createServer, type Server } from 'node:http';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import { createDatabasePool } from '../../../storage/database.js';
import { receiveMessage, type ReceiveResult } from '../inbox.js';
import type { TenantQueryable } from '../../../security/tool-approval-store.js';
import { createAgentExecutionStore, type ExecutionHooks, type Fence } from '../../persistence/execution-store.js';
import { WORKFLOW_SCOPES, ACTION_REQUEST, ACTION_RESULT, TRIAGE_AGENT, delegateAndDispatch, type TriageArguments } from '../workflow.js';
import { buildWireMessage, payloadDigest } from '../wire.js';
import { argumentsDigest } from '../../delegation.js';
import { withMessagingContext } from '../context.js';

// Shared helpers for P5 integration tests. Test code only: nothing here runs in the API process.

export const CHILD = fileURLToPath(new URL('./messaging-child.ts', import.meta.url));
export const SPIFFE = {
  orchestrator: 'spiffe://aegis.local/workload/orchestrator',
  triage: 'spiffe://aegis.local/workload/triage',
  retrieval: 'spiffe://aegis.local/workload/retrieval',
  reviewer: 'spiffe://aegis.local/workload/reviewer',
  unregistered: 'spiffe://aegis.local/workload/probe',
} as const;
export const principalRef = (label: string) => createHash('sha256').update(`synthetic-principal:${label}`).digest('hex');
export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function requireEnv(): { adminUrl: string; runtimeUrl: string } {
  const adminUrl = process.env.TEST_DATABASE_ADMIN_URL;
  const runtimeUrl = process.env.TEST_DATABASE_URL;
  if (!adminUrl || !runtimeUrl) throw new Error('Set TEST_DATABASE_ADMIN_URL and TEST_DATABASE_URL for real PostgreSQL tests.');
  return { adminUrl, runtimeUrl };
}

export interface WorkerHandle {
  readonly child: ChildProcess;
  waitForEvent(name: string, timeoutMs?: number): Promise<Record<string, unknown>>;
  exited(): Promise<{ code: number | null; signal: NodeJS.Signals | null; events: Array<Record<string, unknown>> }>;
  kill(): void;
}

/** Starts one messaging worker process. Each worker has its own PostgreSQL connections, as the runtime role. */
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
    waitForEvent(name, timeoutMs = 20000) {
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

/** A stand-in for one agent's egress proxy, in-process. It only chooses the verified peer identity; the inbox code is the real one. */
export interface StubEgress { readonly url: string; readonly deliveries: Array<{ messageId: string; destination: string; status: number }>;
  mode: 'deliver' | 'unavailable' | 'refuse_identity' | 'deliver_lose_ack'; close(): Promise<void>; }

export async function startStubEgress(pool: Pool, senderSpiffeId: string, hooks: ExecutionHooks = {}): Promise<StubEgress> {
  const deliveries: Array<{ messageId: string; destination: string; status: number }> = [];
  const stub: { mode: StubEgress['mode'] } = { mode: 'deliver' };
  const server: Server = createServer((request, response) => {
    if (request.method !== 'POST' || request.url !== '/v1/deliver') { response.writeHead(404).end(); return; }
    const chunks: Buffer[] = [];
    request.on('data', (c: Buffer) => chunks.push(c));
    request.on('end', () => {
      void (async () => {
        const destination = String(request.headers['x-aegis-destination'] ?? '');
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { messageId: string };
        const send = (status: number, json: Record<string, unknown>) => {
          deliveries.push({ messageId: body.messageId, destination, status });
          response.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(json));
        };
        if (stub.mode === 'unavailable') return send(503, { status: 'transient', reason: 'receiver_unavailable' });
        if (stub.mode === 'refuse_identity') return send(403, { status: 'refused', reason: 'peer_identity_refused' });
        if (destination !== TRIAGE_AGENT && destination !== 'orchestrator') return send(404, { status: 'refused', reason: 'unknown_destination' });
        const receiver = destination;
        const result: ReceiveResult = await receiveMessage(pool, hooks, { receiver, peerSpiffeId: senderSpiffeId, messageId: body.messageId, body });
        if (stub.mode === 'deliver_lose_ack') return send(503, { status: 'transient', reason: 'ack_lost' });
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
    get mode() { return stub.mode; },
    set mode(value: StubEgress['mode']) { stub.mode = value; },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  } as StubEgress;
}

export interface Harness {
  readonly adminPool: Pool;
  readonly pool: Pool;
  readonly tenantA: string;
  readonly tenantB: string;
  readonly store: ReturnType<typeof createAgentExecutionStore>;
}

export const runTenantFor = (pool: Pool) => <T>(tenantId: string, operation: (client: TenantQueryable) => Promise<T>) =>
  withMessagingContext(pool, { tenantId, agentId: SPIFFE.orchestrator.split('/').pop() }, operation);

export async function createHarness(): Promise<Harness> {
  const { adminUrl, runtimeUrl } = requireEnv();
  const adminPool = new Pool({ connectionString: adminUrl, max: 4 });
  // A database restart drops idle connections. The pool reconnects on the next query, so the error is not a test failure.
  adminPool.on('error', () => undefined);
  const pool = createDatabasePool(runtimeUrl, 12);
  const tenantA = randomUUID();
  const tenantB = randomUUID();
  await adminPool.query(`INSERT INTO aegis.tenants (id, name) VALUES ($1, 'Synthetic North'), ($2, 'Synthetic South')`, [tenantA, tenantB]);
  const store = createAgentExecutionStore(runTenantFor(pool));
  return { adminPool, pool, tenantA, tenantB, store };
}

export interface Started { readonly executionId: string; readonly fence: Fence; readonly requestMessageId: string; readonly tenantId: string;
  readonly args: TriageArguments }

/** Creates an execution, claims it as the orchestrator and dispatches the triage request, all through the real decision path. */
export async function startExecution(h: Harness, options: { tenantId?: string; documentCount?: number; grantTtlSeconds?: number;
  maxAttempts?: number; leaseSeconds?: number; hooks?: ExecutionHooks } = {}): Promise<Started> {
  const tenantId = options.tenantId ?? h.tenantA;
  const created = await h.store.createExecution({ tenantId, idempotencyKey: randomUUID(), principalRef: principalRef('case-owner'),
    principalScopes: ['case:read', 'document:read'], limits: { maxDepth: 3, maxDelegations: 4, maxSteps: 8 },
    grantTtlSeconds: options.grantTtlSeconds ?? 300, maxAttempts: options.maxAttempts ?? 6 });
  const claim = await h.store.claim({ tenantId, executionId: created.executionId, spiffeId: SPIFFE.orchestrator,
    instance: 'orchestrator-test', leaseSeconds: options.leaseSeconds ?? 120 });
  if (!claim.ok) throw new Error(`claim refused: ${claim.reason}`);
  const fence: Fence = { tenantId, executionId: created.executionId, agentId: claim.value.agentId, instance: 'orchestrator-test',
    fencingToken: claim.value.fencingToken };
  const args: TriageArguments = { caseRef: randomUUID(), documentCount: options.documentCount ?? 3, questionCode: 'status_check' };
  const dispatched = await delegateAndDispatch(h.pool, options.hooks ?? {}, { tenantId, fence, to: TRIAGE_AGENT,
    requestedScopes: [...WORKFLOW_SCOPES], action: ACTION_REQUEST, resultAction: ACTION_RESULT, arguments: args, maxAttempts: options.maxAttempts ?? 6 });
  if (!dispatched.ok) throw new Error(`dispatch refused: ${dispatched.reason}`);
  return { executionId: created.executionId, fence, requestMessageId: dispatched.requestMessageId, tenantId, args };
}

/** Reads the message row and envelope back, as the runtime would. Used to build tampered variants in tests. */
export async function readRequestWire(h: Harness, started: Started): Promise<{ messageId: string; tenantId: string; executionId: string;
  kind: 'request'; envelope: Record<string, unknown>; payload: Record<string, unknown>; payloadDigest: string }> {
  const row = await h.adminPool.query<{ envelope: Record<string, unknown>; payload: Record<string, unknown>; payload_digest: string }>(
    'SELECT envelope, payload, payload_digest FROM aegis.agent_outbox WHERE message_id = $1', [started.requestMessageId]);
  return { messageId: started.requestMessageId, tenantId: started.tenantId, executionId: started.executionId, kind: 'request',
    envelope: row.rows[0].envelope, payload: row.rows[0].payload, payloadDigest: row.rows[0].payload_digest };
}

export function wireBody(message: { messageId: string; tenantId: string; executionId: string; kind: 'request' | 'result';
  envelope: Record<string, unknown>; payload: Record<string, unknown> }): Record<string, unknown> {
  return JSON.parse(JSON.stringify(buildWireMessage(message)));
}

export { argumentsDigest, payloadDigest, ACTION_REQUEST };

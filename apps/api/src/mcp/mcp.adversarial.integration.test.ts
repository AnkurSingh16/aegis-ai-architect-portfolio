import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { z } from 'zod';
import type { ToolHandler } from '../agents/tool-dispatcher.js';
import { createTestAuthentication, TEST_ISSUER } from '../auth/test-authentication.js';
import { createDatabasePool } from '../storage/database.js';
import { migrateDatabase } from '../storage/migrations.js';
import { createPostgresApprovalStore, type TenantQueryable } from '../security/tool-approval-store.js';
import { memoryAuditSink, type McpAuditEvent } from './audit.js';
import { createAegisMcpServer, createRegisteredServer, type AegisMcpServerOptions, type ToolRegistry } from './server.js';
import { createTestAegisMcpServer, type TestToolExtension } from './test-support.js';
import { MCP_TOOL_SPECS, mcpToolDefinitions } from './tools.js';
import type { ValidationDiagnostic } from './gate.js';

// Adversarial protocol tests over a real SDK client, real PostgreSQL and the production verifier. They exercise the pre-dispatch
// gate, admission control, the production registry boundary, audit coverage and database failures.
const adminUrl = process.env.TEST_DATABASE_ADMIN_URL;
const runtimeUrl = process.env.TEST_DATABASE_URL;
const appPassword = process.env.DATABASE_APP_PASSWORD;
const ingestPassword = process.env.DATABASE_INGEST_PASSWORD;
if (!adminUrl || !runtimeUrl || !appPassword || !ingestPassword) {
  throw new Error('Set TEST_DATABASE_ADMIN_URL, TEST_DATABASE_URL, DATABASE_APP_PASSWORD and DATABASE_INGEST_PASSWORD.');
}

const admin = new Pool({ connectionString: adminUrl, max: 1 });
const pool = createDatabasePool(runtimeUrl, 4);
const tenantA = randomUUID();
const tenantB = randomUUID();
const member = `adv-member-${randomUUID()}`;
const stranger = `adv-stranger-${randomUUID()}`;
const VALID_CASE = 'SYNTHETIC-LOGIN-001';

const runTenant = async <T>(tenantId: string, operation: (client: TenantQueryable) => Promise<T>): Promise<T> => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('aegis.tenant_id', $1, true)", [tenantId]);
    const result = await operation(client as unknown as TenantQueryable);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
};

let auth: Awaited<ReturnType<typeof createTestAuthentication>>;
let memberToken: string;
let strangerToken: string;
const open: { close(): Promise<void> }[] = [];

beforeAll(async () => {
  await migrateDatabase(adminUrl, appPassword, ingestPassword);
  auth = await createTestAuthentication();
  await admin.query("INSERT INTO aegis.tenants (id, name) VALUES ($1, 'Synthetic North'), ($2, 'Synthetic South')", [tenantA, tenantB]);
  await admin.query("INSERT INTO aegis.memberships (issuer, subject, tenant_id, role) VALUES ($1, $2, $3, 'reader')", [TEST_ISSUER, member, tenantA]);
  memberToken = await auth.sign(member, ['read:cases']);
  strangerToken = await auth.sign(stranger, ['read:cases']);
});

afterAll(async () => {
  for (const handle of open) await handle.close().catch(() => undefined);
  await pool.end();
  await admin.end();
});

/** A pool wrapper that counts connection requests and the peak number of requests in progress. */
function observedPool(delayMs = 0, failWith?: string) {
  let connects = 0;
  let outstanding = 0;
  let peak = 0;
  const wrapped = new Proxy(pool, {
    get(target, property) {
      if (property === 'connect') {
        return async () => {
          connects += 1;
          outstanding += 1;
          peak = Math.max(peak, outstanding);
          try {
            if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
            if (failWith !== undefined) throw new Error(failWith);
            return await target.connect();
          } finally {
            outstanding -= 1;
          }
        };
      }
      const value = Reflect.get(target, property) as unknown;
      return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  }) as unknown as Pool;
  return { pool: wrapped, connects: () => connects, peak: () => peak };
}

async function serve(options: Partial<AegisMcpServerOptions> & { token: string; poolOverride?: Pool }, extension?: TestToolExtension) {
  const audit = memoryAuditSink();
  const base: AegisMcpServerOptions = {
    pool: options.poolOverride ?? pool, bearerToken: options.token, tenantId: options.tenantId ?? tenantA, verify: auth.verify,
    approvals: createPostgresApprovalStore(runTenant), audit, admission: options.admission, diagnostics: options.diagnostics,
  };
  const server = extension ? createTestAegisMcpServer(base, extension) : createAegisMcpServer(base);
  const client = new Client({ name: 'adv-client', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const handle = { client, audit, close: async () => { await client.close(); await server.close(); } };
  open.push(handle);
  return handle;
}

const textOf = (result: unknown) => JSON.stringify(result);
const reasonsOf = (events: McpAuditEvent[]) => events.map((e) => `${e.outcome}:${e.reasons.join('|')}`);

describe('repeated unauthorised requests and pre-membership throttling', () => {
  it('throttles repeated non-member calls before any further membership query', async () => {
    const counted = observedPool();
    const harness = await serve({ token: strangerToken, poolOverride: counted.pool, admission: { burst: 3, refillPerSecond: 0.000001, maxConcurrent: 2 } });
    const results = [];
    for (let i = 0; i < 10; i += 1) {
      results.push(await harness.client.callTool({ name: 'documents.search', arguments: { query: 'refund' } }));
    }
    expect(results.every((r) => r.isError === true)).toBe(true);
    // Only the first three calls were admitted to the database check. The other seven never reached the pool.
    expect(counted.connects()).toBe(3);
    const outcomes = harness.audit.events.map((e) => e.outcome);
    expect(outcomes.filter((o) => o === 'not_a_member')).toHaveLength(3);
    expect(outcomes.filter((o) => o === 'throttled')).toHaveLength(7);
    expect(textOf(results[9])).toContain('Too many requests');
  });

  it('keeps refused calls distinct from database-level denials in the audit trail', async () => {
    const harness = await serve({ token: strangerToken, admission: { burst: 1, refillPerSecond: 0.000001, maxConcurrent: 2 } });
    await harness.client.callTool({ name: 'documents.search', arguments: { query: 'refund' } });
    await harness.client.callTool({ name: 'documents.search', arguments: { query: 'refund' } });
    expect(reasonsOf(harness.audit.events)).toEqual(['not_a_member:membership', 'throttled:admission_throttled']);
  });
});

describe('concurrency bounds', () => {
  it('admits no more concurrent calls than the configured cap, and refuses the rest', async () => {
    const slowed = observedPool(80);
    const harness = await serve({ token: memberToken, poolOverride: slowed.pool, admission: { burst: 30, refillPerSecond: 5, maxConcurrent: 1 } });
    const results = await Promise.all([1, 2, 3, 4].map(() => harness.client.callTool({ name: 'case.triage', arguments: { caseId: VALID_CASE } })));
    const succeeded = results.filter((r) => r.isError !== true);
    const refused = results.filter((r) => r.isError === true);
    expect(succeeded).toHaveLength(1);
    expect(refused).toHaveLength(3);
    expect(slowed.peak()).toBeLessThanOrEqual(1);
    // Every call, admitted or refused, wrote exactly one audit event.
    expect(harness.audit.events).toHaveLength(4);
  });

  it('refuses a second message that reuses an in-flight request id, without a second slot', async () => {
    const harness = await serve({ token: memberToken });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createAegisMcpServer({
      pool, bearerToken: memberToken, tenantId: tenantA, verify: auth.verify, approvals: createPostgresApprovalStore(runTenant), audit: harness.audit,
    });
    await server.connect(serverTransport);
    await clientTransport.start();
    const message = { jsonrpc: '2.0', id: 'same-id', method: 'tools/call', params: { name: 'case.triage', arguments: { caseId: VALID_CASE } } };
    await clientTransport.send(message as never);
    await clientTransport.send(message as never);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(harness.audit.events.filter((e) => e.reasons.includes('duplicate_request_id'))).toHaveLength(1);
    await server.close();
  });
});

describe('invalid, malformed and unregistered calls', () => {
  it('refuses extra fields and does not repeat the submitted value', async () => {
    const harness = await serve({ token: memberToken });
    const result = await harness.client.callTool({ name: 'case.triage', arguments: { caseId: VALID_CASE, tenantId: 'SECRET-VALUE-42' } });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('Invalid request.');
    expect(textOf(result)).not.toContain('SECRET-VALUE-42');
    expect(textOf(harness.audit.events)).not.toContain('SECRET-VALUE-42');
    expect(harness.audit.events.at(-1)).toMatchObject({ outcome: 'invalid_input', reasons: ['schema_validation'], detail: { issueCount: 1 } });
  });

  it('refuses unknown, differently cased and path-like tool names', async () => {
    const harness = await serve({ token: memberToken });
    for (const name of ['no.such.tool', 'CASE.TRIAGE', 'case.triage/../documents.search']) {
      const result = await harness.client.callTool({ name, arguments: {} }).catch((error: Error) => ({ isError: true, error }));
      expect(result.isError).toBe(true);
    }
    expect(harness.audit.events.every((e) => e.outcome === 'invalid_input' && e.tool === 'unregistered')).toBe(true);
  });

  it('refuses arguments that are not an object', async () => {
    const harness = await serve({ token: memberToken });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createAegisMcpServer({
      pool, bearerToken: memberToken, tenantId: tenantA, verify: auth.verify, approvals: createPostgresApprovalStore(runTenant), audit: harness.audit,
    });
    await server.connect(serverTransport);
    await clientTransport.start();
    await clientTransport.send({ jsonrpc: '2.0', id: 'arr-1', method: 'tools/call', params: { name: 'case.triage', arguments: ['x'] } } as never);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(harness.audit.events.at(-1)).toMatchObject({ outcome: 'invalid_input', reasons: ['malformed_request'] });
    await server.close();
  });

  it('writes a diagnostic with field paths and codes, never values, when enabled', async () => {
    const diagnostics: ValidationDiagnostic[] = [];
    const harness = await serve({ token: memberToken, diagnostics: (event) => diagnostics.push(event) });
    await harness.client.callTool({ name: 'case.triage', arguments: { caseId: 'SECRET-CASE-VALUE-7' } });
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].tool).toBe('case.triage');
    expect(diagnostics[0].issues[0].path).toBe('caseId');
    expect(JSON.stringify(diagnostics)).not.toContain('SECRET-CASE-VALUE-7');
  });
});

describe('unexpected tool registration and the production registry boundary', () => {
  it('ignores an extension passed to the production factory, so no extra tool is listed or callable', async () => {
    const extra = {
      specs: [{ name: 'synthetic.write', title: 'x', description: 'x', inputSchema: z.object({}).strict(), outputSchema: z.object({}).strict(), requiredScopes: ['write:synthetic'] }],
      definitions: [{ name: 'synthetic.write', requiredScopes: ['write:synthetic'], sideEffect: 'write' as const, requiresApproval: true }],
      handlers: new Map<string, ToolHandler<unknown, unknown>>(),
    };
    const options = { pool, bearerToken: memberToken, tenantId: tenantA, verify: auth.verify, approvals: createPostgresApprovalStore(runTenant), audit: memoryAuditSink() };
    const withExtension = { ...options, extension: extra };
    const server = createAegisMcpServer(withExtension);
    const client = new Client({ name: 'adv-client', version: '0.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    open.push({ close: async () => { await client.close(); await server.close(); } });
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(MCP_TOOL_SPECS.map((s) => s.name).sort());
    const called = await client.callTool({ name: 'synthetic.write', arguments: {} });
    expect(called.isError).toBe(true);
  });

  it('refuses to build a side-effecting server outside test runs', async () => {
    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      const options = { pool, bearerToken: memberToken, tenantId: tenantA, verify: auth.verify, approvals: createPostgresApprovalStore(runTenant), audit: memoryAuditSink() };
      expect(() => createTestAegisMcpServer(options, { specs: [], definitions: [], handlers: new Map() })).toThrow(/only in test runs/);
    } finally {
      process.env.NODE_ENV = previous;
    }
  });

  it('refuses a read-only policy registry that contains a side-effecting definition', () => {
    const registry: ToolRegistry = {
      specs: MCP_TOOL_SPECS,
      definitions: [...mcpToolDefinitions(), { name: 'case.close', requiredScopes: ['read:cases'], sideEffect: 'write', requiresApproval: true }],
      agentScopes: [],
      handlersFor: () => new Map(),
    };
    const options = { pool, bearerToken: memberToken, tenantId: tenantA, verify: auth.verify, approvals: createPostgresApprovalStore(runTenant), audit: memoryAuditSink() };
    expect(() => createRegisteredServer(options, registry, { allowSideEffects: false })).toThrow(/read-only/);
  });
});

describe('database failures', () => {
  it('returns a generic error and audits it, without the underlying message', async () => {
    const broken = observedPool(0, 'simulated outage at db-internal-host');
    const harness = await serve({ token: memberToken, poolOverride: broken.pool });
    const result = await harness.client.callTool({ name: 'documents.search', arguments: { query: 'refund' } });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('The request could not be completed. Please retry.');
    expect(textOf(result)).not.toContain('db-internal-host');
    expect(harness.audit.events.at(-1)).toMatchObject({ outcome: 'error', reasons: ['membership_check'] });
  });
});

describe('audit coverage across admitted and refused calls', () => {
  it('writes exactly one structured event for each call, with the expected outcome order', async () => {
    const harness = await serve({ token: memberToken });
    await harness.client.callTool({ name: 'case.triage', arguments: { caseId: VALID_CASE } });
    await harness.client.callTool({ name: 'case.triage', arguments: { caseId: VALID_CASE, tenantId: tenantB } });
    await harness.client.callTool({ name: 'no.such.tool', arguments: {} }).catch(() => undefined);
    await harness.client.callTool({ name: 'documents.search', arguments: { query: 'refund' } });
    expect(reasonsOf(harness.audit.events)).toEqual([
      'allowed:',
      'invalid_input:schema_validation',
      'invalid_input:unknown_tool',
      'allowed:',
    ]);
    for (const event of harness.audit.events) {
      expect(event.subjectRef === null || /^[0-9a-f]{12}$/.test(event.subjectRef)).toBe(true);
    }
  });
});

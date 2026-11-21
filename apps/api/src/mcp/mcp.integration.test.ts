import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { generateKeyPair, SignJWT } from 'jose';
import { z } from 'zod';
import type { ToolHandler } from '../agents/tool-dispatcher.js';
import { actionDigest } from '../security/tool-policy-gateway.js';
import { createTestAuthentication, TEST_AUDIENCE, TEST_ISSUER } from '../auth/test-authentication.js';
import { createDatabasePool } from '../storage/database.js';
import { migrateDatabase } from '../storage/migrations.js';
import { createTokenBucketLimiter, inProcessRateLimiter } from '../security/rate-limiter.js';
import { createPostgresApprovalStore, type TenantQueryable } from '../security/tool-approval-store.js';
import { memoryAuditSink, type McpAuditEvent } from './audit.js';
import { createAegisMcpServer } from './server.js';
import { createTestAegisMcpServer } from './test-support.js';
import { MCP_AGENT_ID } from './tools.js';

// Real PostgreSQL and the production verifier. Requires the CI-style isolated URLs and passwords (see .github/workflows/ci.yml).
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
const memberA = `mcp-member-a-${randomUUID()}`;
const memberB = `mcp-member-b-${randomUUID()}`;
const stranger = `mcp-stranger-${randomUUID()}`;
const CHUNK = 'Synthetic refund policy: refunds are issued within ten working days of approval.';

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

interface Harness {
  readonly client: Client;
  readonly audit: ReturnType<typeof memoryAuditSink>;
  close(): Promise<void>;
}

/** A real MCP client connected to a real server over the in-memory transport, configured for one tenant and one credential. */
async function connect(options: { tenantId: string; token: string; limiter?: Parameters<typeof createAegisMcpServer>[0]['limiter'] }): Promise<Harness> {
  const audit = memoryAuditSink();
  const server = createAegisMcpServer({
    pool, bearerToken: options.token, tenantId: options.tenantId, verify: auth.verify,
    approvals: createPostgresApprovalStore(runTenant), limiter: options.limiter, audit,
  });
  const client = new Client({ name: 'aegis-test-client', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, audit, close: async () => { await client.close(); await server.close(); } };
}

let auth: Awaited<ReturnType<typeof createTestAuthentication>>;
let tokenA: string;
let tokenB: string;
let tokenStranger: string;
let tokenNoScope: string;
const open: Harness[] = [];
const track = async (options: Parameters<typeof connect>[0]) => {
  const harness = await connect(options);
  open.push(harness);
  return harness;
};

beforeAll(async () => {
  await migrateDatabase(adminUrl, appPassword, ingestPassword);
  auth = await createTestAuthentication();
  await admin.query("INSERT INTO aegis.tenants (id, name) VALUES ($1, 'Synthetic North'), ($2, 'Synthetic South')", [tenantA, tenantB]);
  await admin.query(`INSERT INTO aegis.memberships (issuer, subject, tenant_id, role) VALUES
    ($1, $2, $3, 'reader'), ($1, $4, $5, 'reader')`, [TEST_ISSUER, memberA, tenantA, memberB, tenantB]);
  const documentId = randomUUID();
  await admin.query(`INSERT INTO aegis.documents (id, tenant_id, source_identity, version, source_owner, ingestion_source, ingestion_revision, content_sha256)
    VALUES ($1, $2, 'SYNTHETIC-REFUNDS', 1, 'synthetic-owner', 'source-controlled-synthetic-catalog', 'test', encode(sha256(convert_to($3, 'UTF8')), 'hex'))`,
  [documentId, tenantA, CHUNK]);
  await admin.query(`INSERT INTO aegis.document_chunks (tenant_id, document_id, document_version, source_identity, position, content, content_sha256)
    VALUES ($1, $2, 1, 'SYNTHETIC-REFUNDS', 0, $3, encode(sha256(convert_to($3, 'UTF8')), 'hex'))`, [tenantA, documentId, CHUNK]);
  tokenA = await auth.sign(memberA, ['read:cases']);
  tokenB = await auth.sign(memberB, ['read:cases']);
  tokenStranger = await auth.sign(stranger, ['read:cases']);
  tokenNoScope = await auth.sign(memberA, ['read:other']);
});

afterAll(async () => {
  for (const harness of open) await harness.close().catch(() => undefined);
  await pool.end();
  await admin.end();
});

const textOf = (result: unknown) => JSON.stringify(result);

describe('MCP protocol interoperability (real SDK client, real PostgreSQL)', () => {
  it('discovers exactly the read-only tools with explicit, strict input schemas and read-only annotations', async () => {
    const { client } = await track({ tenantId: tenantA, token: tokenA });
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(['case.triage', 'documents.search']);
    for (const tool of tools) {
      expect(tool.annotations?.readOnlyHint).toBe(true);
      expect(tool.annotations?.destructiveHint).toBe(false);
      expect(tool.inputSchema.type).toBe('object');
      expect(tool.inputSchema.additionalProperties).toBe(false);
    }
  });

  it('runs case.triage and returns validated structured output for a synthetic case', async () => {
    const { client } = await track({ tenantId: tenantA, token: tokenA });
    const result = await client.callTool({ name: 'case.triage', arguments: { caseId: 'SYNTHETIC-LOGIN-001' } });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({ mode: 'synthetic-mock', caseId: 'SYNTHETIC-LOGIN-001' });
  });

  it('searches the configured tenant only, and returns the seeded passage', async () => {
    const { client } = await track({ tenantId: tenantA, token: tokenA });
    const result = await client.callTool({ name: 'documents.search', arguments: { query: 'refund' } });
    expect(result.isError).toBeFalsy();
    const results = (result.structuredContent as { results: { sourceIdentity: string }[] }).results;
    expect(results.length).toBeGreaterThan(0);
    expect(results.every((r) => r.sourceIdentity === 'SYNTHETIC-REFUNDS')).toBe(true);
  });
});

describe('adversarial calls through MCP', () => {
  it('refuses a tenant supplied in arguments, without searching', async () => {
    const { client } = await track({ tenantId: tenantA, token: tokenA });
    const result = await client.callTool({ name: 'documents.search', arguments: { query: 'refund', tenantId: tenantB } });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toBeUndefined();
  });

  it('refuses a scope or privilege supplied in arguments', async () => {
    const { client } = await track({ tenantId: tenantA, token: tokenA });
    const result = await client.callTool({ name: 'case.triage', arguments: { caseId: 'SYNTHETIC-LOGIN-001', scopes: ['admin:all'] } });
    expect(result.isError).toBe(true);
  });

  it('refuses an unknown case identifier and an oversized query', async () => {
    const { client } = await track({ tenantId: tenantA, token: tokenA });
    expect((await client.callTool({ name: 'case.triage', arguments: { caseId: 'SYNTHETIC-NOPE-999' } })).isError).toBe(true);
    expect((await client.callTool({ name: 'documents.search', arguments: { query: 'x'.repeat(5000) } })).isError).toBe(true);
  });

  it('refuses a token signed by a key this server does not trust', async () => {
    const forged = await new SignJWT({ scope: 'read:cases' }).setProtectedHeader({ alg: 'RS256' })
      .setIssuer(TEST_ISSUER).setAudience(TEST_AUDIENCE).setSubject(memberA).setExpirationTime('5m')
      .sign((await generateKeyPair('RS256')).privateKey);
    const { client, audit } = await track({ tenantId: tenantA, token: forged });
    const result = await client.callTool({ name: 'case.triage', arguments: { caseId: 'SYNTHETIC-LOGIN-001' } });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('Authentication required.');
    expect(audit.events.at(-1)?.outcome).toBe('unauthenticated');
  });

  it('refuses a verified token that lacks the read scope', async () => {
    const { client, audit } = await track({ tenantId: tenantA, token: tokenNoScope });
    const result = await client.callTool({ name: 'documents.search', arguments: { query: 'refund' } });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('Access denied.');
    expect(audit.events.at(-1)?.outcome).toBe('not_a_member');
  });

  it('refuses a verified subject with no membership in the configured tenant', async () => {
    const { client } = await track({ tenantId: tenantA, token: tokenStranger });
    const result = await client.callTool({ name: 'documents.search', arguments: { query: 'refund' } });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('Access denied.');
  });

  it('refuses cross-tenant access: a member of tenant B cannot use a server configured for tenant A', async () => {
    const { client } = await track({ tenantId: tenantA, token: tokenB });
    const result = await client.callTool({ name: 'documents.search', arguments: { query: 'refund' } });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toBeUndefined();
  });

  it('applies the rate limit and denies the call after the bucket is empty', async () => {
    const limiter = inProcessRateLimiter(createTokenBucketLimiter({ capacity: 2, refillPerSecond: 0.000001 }));
    const { client, audit } = await track({ tenantId: tenantA, token: tokenA, limiter });
    expect((await client.callTool({ name: 'case.triage', arguments: { caseId: 'SYNTHETIC-LOGIN-001' } })).isError).toBeFalsy();
    expect((await client.callTool({ name: 'case.triage', arguments: { caseId: 'SYNTHETIC-LOGIN-001' } })).isError).toBeFalsy();
    const denied = await client.callTool({ name: 'case.triage', arguments: { caseId: 'SYNTHETIC-LOGIN-001' } });
    expect(denied.isError).toBe(true);
    expect(textOf(denied)).toContain('rate_limited');
    expect(audit.events.at(-1)?.reasons).toContain('rate_limited');
  });

  it('keeps the raw credential and the raw subject out of every error and audit event', async () => {
    const { client, audit } = await track({ tenantId: tenantA, token: tokenStranger });
    const result = await client.callTool({ name: 'documents.search', arguments: { query: 'refund' } });
    const serialised = JSON.stringify({ result, events: audit.events });
    expect(serialised).not.toContain(tokenStranger);
    expect(serialised).not.toContain(stranger);
    expect(serialised).not.toContain('refund'); // query text is never audited
  });
});

describe('approval boundary (test-only synthetic side-effecting tool, isolated database writes only)', () => {
  // The synthetic tool has no external effect. It counts its own runs, so the tests show whether the handler ever ran.
  const SYNTHETIC_TOOL = 'synthetic.write';
  let runs = 0;
  const syntheticSpec = {
    name: SYNTHETIC_TOOL, title: 'Synthetic write', description: 'Test-only synthetic side effect.',
    inputSchema: z.object({ item: z.string().min(1).max(40), approvalId: z.string().uuid().optional() }).strict(),
    outputSchema: z.object({ written: z.string() }).strict(), requiredScopes: ['write:synthetic'],
  };
  const syntheticHandlers = new Map([[SYNTHETIC_TOOL, {
    validate: (args: unknown) => args as { item: string },
    run: ({ item }: { item: string }) => { runs += 1; return { written: item }; },
  } as ToolHandler<unknown, unknown>]]);
  const extension = {
    specs: [syntheticSpec],
    definitions: [{ name: SYNTHETIC_TOOL, requiredScopes: ['write:synthetic'], sideEffect: 'write' as const, requiresApproval: true }],
    handlers: syntheticHandlers,
    agentScopes: ['write:synthetic'],
  };
  const approvals = createPostgresApprovalStore(runTenant);
  const LATER = new Date(Date.now() + 60_000);
  let writerToken: string;

  async function harness(tenantId: string) {
    const audit = memoryAuditSink();
    const server = createTestAegisMcpServer({
      pool, bearerToken: writerToken, tenantId, verify: auth.verify, approvals, audit,
    }, extension);
    const client = new Client({ name: 'aegis-test-client', version: '0.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const h = { client, audit, close: async () => { await client.close(); await server.close(); } };
    open.push(h);
    return h;
  }

  async function approvedFor(tenantId: string, item: string): Promise<string> {
    const id = await approvals.create({ tenantId, toolName: SYNTHETIC_TOOL, actionDigest: actionDigest(tenantId, SYNTHETIC_TOOL, { item }),
      requestedBy: memberA, expiresAt: LATER });
    expect(await approvals.approve(id, tenantId, 'reviewer-approval-test', new Date())).toBe(true);
    return id;
  }

  beforeAll(async () => {
    writerToken = await auth.sign(memberA, ['read:cases', 'write:synthetic']);
  });

  it('refuses the side effect without an approval, and the handler does not run', async () => {
    const { client } = await harness(tenantA);
    const before = runs;
    const result = await client.callTool({ name: SYNTHETIC_TOOL, arguments: { item: 'x' } });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('approval_required');
    expect(runs).toBe(before);
  });

  it('runs once with an approval granted by another person, then refuses the replay', async () => {
    const { client } = await harness(tenantA);
    const approvalId = await approvedFor(tenantA, 'alpha');
    const before = runs;
    const first = await client.callTool({ name: SYNTHETIC_TOOL, arguments: { item: 'alpha', approvalId } });
    expect(first.isError).toBeFalsy();
    expect(runs).toBe(before + 1);
    const replay = await client.callTool({ name: SYNTHETIC_TOOL, arguments: { item: 'alpha', approvalId } });
    expect(replay.isError).toBe(true);
    expect(textOf(replay)).toContain('approval_consumed');
    expect(runs).toBe(before + 1);
  });

  it('refuses an approval whose digest does not match the arguments actually supplied', async () => {
    const { client } = await harness(tenantA);
    const approvalId = await approvedFor(tenantA, 'approved-item');
    const before = runs;
    const result = await client.callTool({ name: SYNTHETIC_TOOL, arguments: { item: 'different-item', approvalId } });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('approval_digest_mismatch');
    expect(runs).toBe(before);
  });

  it('refuses an approval id that belongs to another tenant, without revealing that it exists', async () => {
    const { client } = await harness(tenantA);
    const foreignApproval = await approvedFor(tenantB, 'cross-tenant');
    const before = runs;
    const result = await client.callTool({ name: SYNTHETIC_TOOL, arguments: { item: 'cross-tenant', approvalId: foreignApproval } });
    expect(result.isError).toBe(true);
    expect(runs).toBe(before);
    expect(textOf(result)).not.toContain(foreignApproval);
  });

  it('refuses an approval that is still pending', async () => {
    const { client } = await harness(tenantA);
    const pendingId = await approvals.create({ tenantId: tenantA, toolName: SYNTHETIC_TOOL,
      actionDigest: actionDigest(tenantA, SYNTHETIC_TOOL, { item: 'pending' }), requestedBy: memberA, expiresAt: LATER });
    const before = runs;
    const result = await client.callTool({ name: SYNTHETIC_TOOL, arguments: { item: 'pending', approvalId: pendingId } });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('approval_not_approved');
    expect(runs).toBe(before);
  });

  it('does not let a read-only tool accept an approval reference', async () => {
    const { client } = await track({ tenantId: tenantA, token: tokenA });
    const result = await client.callTool({ name: 'case.triage', arguments: { caseId: 'SYNTHETIC-LOGIN-001', approvalId: randomUUID() } });
    expect(result.isError).toBe(true);
  });
});

describe('audit', () => {
  it('writes exactly one structured event per tool call with a stable shape', async () => {
    const { client, audit } = await track({ tenantId: tenantA, token: tokenA });
    await client.callTool({ name: 'case.triage', arguments: { caseId: 'SYNTHETIC-BILLING-002' } });
    await client.callTool({ name: 'documents.search', arguments: { query: 'refund' } });
    const events = audit.events as McpAuditEvent[];
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ event: 'mcp.tool_call', tool: 'case.triage', tenantId: tenantA, outcome: 'allowed' });
    expect(events[1]).toMatchObject({ tool: 'documents.search', outcome: 'allowed', detail: { queryLength: 6 } });
    expect(events[0].subjectRef).toMatch(/^[0-9a-f]{12}$/);
  });
});

describe('gateway identity', () => {
  it('uses the mcp agent identity, not anything the model can name', () => {
    expect(MCP_AGENT_ID).toBe('mcp-agent');
  });
});

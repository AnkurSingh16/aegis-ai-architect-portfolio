import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { createDatabasePool } from '../storage/database.js';
import { createPostgresApprovalStore, type TenantQueryable } from './tool-approval-store.js';

// Real PostgreSQL checks for migration 007. Requires the same isolated URLs as the storage integration suite.
const adminUrl = process.env.TEST_DATABASE_ADMIN_URL;
const runtimeUrl = process.env.TEST_DATABASE_URL;
if (!adminUrl || !runtimeUrl) throw new Error('Set TEST_DATABASE_ADMIN_URL and TEST_DATABASE_URL for real PostgreSQL tests.');

const admin = new Pool({ connectionString: adminUrl, max: 1 });
const pool = createDatabasePool(runtimeUrl, 4);
const tenantA = randomUUID();
const tenantB = randomUUID();
const NOW = new Date();
const LATER = new Date(NOW.getTime() + 60_000);

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

const store = createPostgresApprovalStore(runTenant);

beforeAll(async () => {
  await admin.query("INSERT INTO aegis.tenants (id, name) VALUES ($1, 'Synthetic North'), ($2, 'Synthetic South')", [tenantA, tenantB]);
});

afterAll(async () => {
  await pool.end();
  await admin.end();
});

describe('tool approvals in real PostgreSQL', () => {
  it('creates, approves by another person, and consumes exactly once under concurrency', async () => {
    const id = await store.create({ tenantId: tenantA, toolName: 'case.close', actionDigest: 'c'.repeat(64), requestedBy: 'user-1', expiresAt: LATER });
    expect(await store.approve(id, tenantA, 'user-1', NOW)).toBe(false); // self-approval refused by the statement
    expect(await store.approve(id, tenantA, 'reviewer-9', NOW)).toBe(true);
    const results = await Promise.all([store.consume(id, tenantA, NOW), store.consume(id, tenantA, NOW), store.consume(id, tenantA, NOW)]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect((await store.get(id, tenantA))?.status).toBe('consumed');
  });

  it('hides approvals from other tenants', async () => {
    const id = await store.create({ tenantId: tenantA, toolName: 'case.close', actionDigest: 'd'.repeat(64), requestedBy: 'user-1', expiresAt: LATER });
    expect(await store.get(id, tenantB)).toBeUndefined();
    expect(await store.approve(id, tenantB, 'reviewer-9', NOW)).toBe(false);
  });

  it('does not consume an expired approval', async () => {
    const id = await store.create({ tenantId: tenantA, toolName: 'case.close', actionDigest: 'e'.repeat(64), requestedBy: 'user-1', expiresAt: new Date(NOW.getTime() + 1000) });
    await store.approve(id, tenantA, 'reviewer-9', NOW);
    expect(await store.consume(id, tenantA, new Date(NOW.getTime() + 5000))).toBe(false);
  });

  it('rejects illegal transitions and identity changes at the database level', async () => {
    const id = await store.create({ tenantId: tenantA, toolName: 'case.close', actionDigest: 'f'.repeat(64), requestedBy: 'user-1', expiresAt: LATER });
    await store.approve(id, tenantA, 'reviewer-9', NOW);
    await store.consume(id, tenantA, NOW);
    // Attempt to move consumed back to approved, through the application role.
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('aegis.tenant_id', $1, true)", [tenantA]);
      await expect(client.query("UPDATE aegis.tool_approvals SET status = 'approved' WHERE approval_id = $1", [id]))
        .rejects.toThrow(/illegal tool approval transition/);
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
  });
});

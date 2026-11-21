import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { createDatabasePool } from '../storage/database.js';
import { migrateDatabase } from '../storage/migrations.js';
import type { TenantQueryable } from './tool-approval-store.js';
import { createPostgresRateLimiter } from './postgres-rate-limiter.js';

// Real PostgreSQL checks for the shared rate limiter: atomicity across concurrent takes, refill, tenant isolation (including
// row level security), bounded rows, and failure handling. The limits here are test values, not production values.
const adminUrl = process.env.TEST_DATABASE_ADMIN_URL;
const runtimeUrl = process.env.TEST_DATABASE_URL;
if (!adminUrl || !runtimeUrl) throw new Error('Set TEST_DATABASE_ADMIN_URL and TEST_DATABASE_URL for real PostgreSQL tests.');

const admin = new Pool({ connectionString: adminUrl, max: 2 });
const pool = createDatabasePool(runtimeUrl, 12);
const tenantA = randomUUID();
const tenantB = randomUUID();

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

beforeAll(async () => {
  await migrateDatabase(adminUrl, process.env.DATABASE_APP_PASSWORD ?? '', process.env.DATABASE_INGEST_PASSWORD ?? '');
  await admin.query("INSERT INTO aegis.tenants (id, name) VALUES ($1, 'Synthetic North'), ($2, 'Synthetic South')", [tenantA, tenantB]);
});

afterAll(async () => {
  await admin.query('DELETE FROM aegis.rate_limit_buckets WHERE tenant_id = ANY($1::uuid[])', [[tenantA, tenantB]]).catch(() => undefined);
  await Promise.all([pool.end(), admin.end()]);
});

describe('shared rate limiter in PostgreSQL', () => {
  it('spends exactly the burst when many workers race for it at once', async () => {
    const limiter = createPostgresRateLimiter(runTenant, { capacity: 5, refillPerSecond: 0.0001 });
    const agent = `race-${randomUUID().slice(0, 8)}`;
    const results = await Promise.all(Array.from({ length: 20 }, () => limiter.take({ tenantId: tenantA, agentId: agent, now: new Date() })));
    expect(results.filter(Boolean)).toHaveLength(5);
  });

  it('refills from the database clock, so a denied caller succeeds after enough time', async () => {
    const limiter = createPostgresRateLimiter(runTenant, { capacity: 1, refillPerSecond: 0.5 });
    const agent = `refill-${randomUUID().slice(0, 8)}`;
    expect(await limiter.take({ tenantId: tenantA, agentId: agent, now: new Date() })).toBe(true);
    expect(await limiter.take({ tenantId: tenantA, agentId: agent, now: new Date() })).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 2100));
    expect(await limiter.take({ tenantId: tenantA, agentId: agent, now: new Date() })).toBe(true);
  });

  it('isolates tenants: one tenant exhausting an agent does not limit another tenant', async () => {
    const limiter = createPostgresRateLimiter(runTenant, { capacity: 1, refillPerSecond: 0.0001 });
    const agent = `iso-${randomUUID().slice(0, 8)}`;
    expect(await limiter.take({ tenantId: tenantA, agentId: agent, now: new Date() })).toBe(true);
    expect(await limiter.take({ tenantId: tenantA, agentId: agent, now: new Date() })).toBe(false);
    expect(await limiter.take({ tenantId: tenantB, agentId: agent, now: new Date() })).toBe(true);
  });

  it('keeps one row per tenant and agent, however many calls arrive', async () => {
    const limiter = createPostgresRateLimiter(runTenant, { capacity: 3, refillPerSecond: 0.0001 });
    const agent = `rows-${randomUUID().slice(0, 8)}`;
    for (let i = 0; i < 10; i += 1) await limiter.take({ tenantId: tenantA, agentId: agent, now: new Date() });
    const count = await runTenant(tenantA, async (client) => (await client.query<{ n: string }>(
      'SELECT count(*)::text AS n FROM aegis.rate_limit_buckets WHERE bucket_key = $1', [agent])).rows[0]!.n);
    expect(count).toBe('1');
  });

  it('keeps buckets invisible across tenants under row level security', async () => {
    const limiter = createPostgresRateLimiter(runTenant, { capacity: 1, refillPerSecond: 0.0001 });
    const agent = `rls-${randomUUID().slice(0, 8)}`;
    await limiter.take({ tenantId: tenantA, agentId: agent, now: new Date() });
    const seenByB = await runTenant(tenantB, async (client) => (await client.query<{ n: string }>(
      'SELECT count(*)::text AS n FROM aegis.rate_limit_buckets WHERE bucket_key = $1', [agent])).rows[0]!.n);
    expect(seenByB).toBe('0');
  });

  it('rejects an oversized agent id before any database work, so no row can be created with it', async () => {
    const limiter = createPostgresRateLimiter(runTenant, { capacity: 1, refillPerSecond: 1 });
    await expect(limiter.take({ tenantId: tenantA, agentId: 'x'.repeat(129), now: new Date() })).rejects.toThrow(RangeError);
  });

  it('propagates a database failure, so the caller can fail closed', async () => {
    const failing = createPostgresRateLimiter(async () => { throw new Error('database unavailable'); }, { capacity: 1, refillPerSecond: 1 });
    await expect(failing.take({ tenantId: tenantA, agentId: 'agent', now: new Date() })).rejects.toThrow('database unavailable');
  });

  it('validates its options', () => {
    expect(() => createPostgresRateLimiter(runTenant, { capacity: 0, refillPerSecond: 1 })).toThrow(RangeError);
    expect(() => createPostgresRateLimiter(runTenant, { capacity: 1, refillPerSecond: 0 })).toThrow(RangeError);
  });
});

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { localDatabaseUrl, requireDevelopment, resolveFixture } from './config.js';
import { CaseRepository, CaseStorageError, validateCaseId, validateStatus, validateSyntheticCase } from './cases.js';
import { executeCaseCommand, parseCaseCommand } from './commands.js';
import { createDatabasePool, verifyRuntimeRole, withTenantTransaction } from './database.js';
import { migrateDatabase } from './migrations.js';

const id = '12345678-1234-4234-8234-123456789abc';
const north = resolveFixture('north');
afterEach(() => vi.unstubAllEnvs());

describe('local storage input boundaries', () => {
  it('resolves only server-owned fixture names', () => {
    expect(north.name).toBe('Synthetic North');
    expect(resolveFixture('south').tenantId).not.toBe(north.tenantId);
    for (const value of [undefined, '', 'NORTH', north.tenantId, '__proto__']) expect(() => resolveFixture(value)).toThrow();
  });
  it.each([undefined, '', 'bad', 'https://localhost/db', 'postgres://remote/db', 'postgres://localhost/',
    'postgres://localhost/db?options=-crole=admin', 'postgres://localhost/db#secret'])('rejects unsafe URL %s', (value) => {
    expect(() => localDatabaseUrl(value)).toThrow();
  });
  it.each(['postgres://localhost/db', 'postgresql://127.0.0.1/db', 'postgres://[::1]/db'])('allows loopback URL %s', (value) => {
    expect(localDatabaseUrl(value)).toBe(value);
  });
  it('refuses storage commands in production', () => {
    vi.stubEnv('NODE_ENV', 'production');
    expect(requireDevelopment).toThrow('local-development');
    vi.stubEnv('NODE_ENV', 'test');
    expect(requireDevelopment).not.toThrow();
  });
  it('validates UUIDs, synthetic cases and status without accepting arbitrary text', () => {
    expect(validateCaseId(id)).toBe(id);
    expect(validateSyntheticCase('SYNTHETIC-LOGIN-001')).toBe('SYNTHETIC-LOGIN-001');
    for (const status of ['open', 'in_progress', 'resolved']) expect(validateStatus(status)).toBe(status);
    for (const value of [undefined, null, {}, [], 1, '', 'DO-NOT-ECHO', "' OR true --"]) {
      expect(() => validateCaseId(value)).toThrow(CaseStorageError);
      expect(() => validateSyntheticCase(value)).toThrow(CaseStorageError);
      expect(() => validateStatus(value)).toThrow(CaseStorageError);
    }
  });
  it('parses every supported command and rejects tenant selectors or extra arguments', () => {
    expect(parseCaseCommand(['list'])).toEqual({ command: 'list' });
    expect(parseCaseCommand(['create', 'SYNTHETIC-LOGIN-001'])).toEqual({ command: 'create', syntheticCase: 'SYNTHETIC-LOGIN-001' });
    for (const command of ['read', 'audit', 'triage']) expect(parseCaseCommand([command, id])).toEqual({ command, id });
    expect(parseCaseCommand(['update', id, 'resolved'])).toEqual({ command: 'update', id, status: 'resolved' });
    for (const args of [[], ['unknown'], ['list', '--tenant', 'south'], ['create'], ['create', 'real-customer'],
      ['read', 'malformed'], ['update', id], ['update', id, 'closed'], ['read', id, north.tenantId]]) {
      expect(() => parseCaseCommand(args)).toThrow(CaseStorageError);
    }
  });
});

function fakePool(query = vi.fn().mockResolvedValue({ rows: [] })) {
  const release = vi.fn();
  const client = { query, release } as unknown as PoolClient;
  return { pool: { connect: vi.fn().mockResolvedValue(client) } as unknown as Pool, query, release };
}

describe('transaction and failure handling', () => {
  it('rejects invalid migration credentials before connecting', async () => {
    for (const password of ['', 'short', 'x'.repeat(257)]) {
      await expect(migrateDatabase('postgres://localhost/aegis_test', password)).rejects.toThrow('16–256');
    }
  });
  it('handles idle connection errors with a stable, secret-free event', async () => {
    const output = vi.spyOn(console, 'error').mockImplementation(() => {});
    const pool = createDatabasePool('postgres://localhost/aegis_test', 1);
    try {
      pool.emit('error', new Error('SECRET CONNECTION STRING'));
      expect(output).toHaveBeenCalledWith(JSON.stringify({ event: 'database.connection_error' }));
    } finally { await pool.end(); output.mockRestore(); }
  });
  it('refuses both CLI entry points in production without connecting or exposing details', async () => {
    const output = vi.spyOn(console, 'error').mockImplementation(() => {});
    const originalExitCode = process.exitCode;
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('DATABASE_URL', 'postgres://user:SECRET@localhost/aegis_test');
    try {
      await import('./cli.js');
      await import('./migrate-cli.js');
      expect(process.exitCode).toBe(1);
      expect(output.mock.calls).toHaveLength(2);
      expect(JSON.stringify(output.mock.calls)).not.toContain('SECRET');
      expect(output.mock.calls.map(([line]) => JSON.parse(line).event))
        .toEqual(['case_command.failed', 'database.migration_failed']);
    } finally { process.exitCode = originalExitCode; output.mockRestore(); }
  });
  it('sets a parameterized transaction-local tenant and releases after commit', async () => {
    const { pool, query, release } = fakePool();
    expect(await withTenantTransaction(pool, north, async () => 'result')).toBe('result');
    expect(query.mock.calls).toEqual([['BEGIN'], ["SELECT set_config('aegis.tenant_id', $1, true)", [north.tenantId]], ['COMMIT']]);
    expect(release).toHaveBeenCalledWith(false);
  });
  it('rolls back on operation failure and destroys a connection when rollback fails', async () => {
    const { pool, query, release } = fakePool();
    query.mockImplementation(async (sql: string) => { if (sql === 'ROLLBACK') throw new Error('broken'); return { rows: [] }; });
    await expect(withTenantTransaction(pool, north, async () => { throw new Error('operation'); })).rejects.toThrow('operation');
    expect(query).toHaveBeenLastCalledWith('ROLLBACK');
    expect(release).toHaveBeenCalledWith(true);
  });
  it('fails closed unless the database confirms runtime safety', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ safe: false }] });
    const pool = { query } as unknown as Pool;
    await expect(verifyRuntimeRole(pool)).rejects.toThrow('Unsafe');
    query.mockResolvedValue({ rows: [] });
    await expect(verifyRuntimeRole(pool)).rejects.toThrow('Unsafe');
    query.mockResolvedValue({ rows: [{ safe: true }] });
    await expect(verifyRuntimeRole(pool)).resolves.toBeUndefined();
  });
  it('does not disclose raw database errors in repository errors or logs', async () => {
    const { pool, query, release } = fakePool();
    query.mockRejectedValue(new Error('postgres://user:SECRET@localhost/db CUSTOMER-CONTENT'));
    const log = vi.fn();
    await expect(new CaseRepository(pool, north, log).list()).rejects.toMatchObject({ code: 'unavailable' });
    expect(JSON.stringify(log.mock.calls)).not.toMatch(/SECRET|CUSTOMER-CONTENT|postgres:/);
    expect(log).toHaveBeenCalledWith(expect.objectContaining({ event: 'case_storage', operation: 'list', outcome: 'failure', code: 'unavailable' }));
    expect(release).toHaveBeenCalledWith(true);
  });
  it('returns tenant-neutral not-found errors', async () => {
    const { pool } = fakePool();
    const repository = new CaseRepository(pool, north, vi.fn());
    await expect(repository.read(id)).rejects.toMatchObject({ code: 'not_found', message: 'Case not found.' });
    await expect(repository.update(id, 'resolved')).rejects.toMatchObject({ code: 'not_found', message: 'Case not found.' });
  });
  it('dispatches supported commands to the repository', async () => {
    const stored = { id, synthetic_case_id: 'SYNTHETIC-LOGIN-001', status: 'open' };
    const { pool, query } = fakePool();
    query.mockImplementation(async (sql: string) => ({ rows: /RETURNING|SELECT \*/.test(sql) ? [stored] : [] }));
    const repository = new CaseRepository(pool, north, vi.fn());
    for (const args of [['create', 'SYNTHETIC-LOGIN-001'], ['list'], ['read', id], ['update', id, 'resolved'], ['audit', id]]) {
      expect(await executeCaseCommand(repository, parseCaseCommand(args))).toBeDefined();
    }
    expect(await executeCaseCommand(repository, parseCaseCommand(['triage', id]))).toMatchObject({ mode: 'synthetic-mock', caseId: 'SYNTHETIC-LOGIN-001' });
  });
});

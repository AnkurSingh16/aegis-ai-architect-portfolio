import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';

/*
 * Unit tests for the orchestrator's cancellation reconciliation. The transaction wrapper and the execution store are replaced at the
 * module boundary, so each test chooses the outcome of finalisation and of failure recording, and asserts the resulting classification,
 * halting behaviour, bounds and SQL. The PostgreSQL behaviour these outcomes depend on is covered by the integration suites.
 */
const mocks = vi.hoisted(() => {
  const store = {
    finaliseCancellation: vi.fn(),
    recordCancellationFailure: vi.fn(),
  };
  const sql: string[] = [];
  const client = {
    query: vi.fn(async (text: string) => {
      sql.push(text);
      return { rows: [] };
    }),
  };
  return { store, sql, client };
});

vi.mock('./context.js', () => ({
  withMessagingContext: vi.fn(async (_pool: unknown, _scope: unknown, op: (c: unknown) => Promise<unknown>) => op(mocks.client)),
}));

vi.mock('../persistence/execution-store.js', () => ({
  createAgentExecutionStore: () => mocks.store,
  joinTransaction: () => () => undefined,
}));

import { classifyFailure, CANCELLATION_RETRY, reconcileCancellations, readCancellationBacklog } from './cancellation.js';

const TENANT = '11111111-1111-4111-8111-111111111111';
const EXEC_A = '22222222-2222-4222-8222-222222222222';
const EXEC_B = '33333333-3333-4333-8333-333333333333';
const HOOKS = {};

function poolWith(rows: { tenant_id: string; execution_id: string; cancellation_attempts: number; cancellation_generation: string }[]): Pool {
  return { query: vi.fn(async () => ({ rows })) } as unknown as Pool;
}

function coded(code: string): Error {
  return Object.assign(new Error(`sqlstate ${code}`), { code });
}

const applied = { ok: true, value: { applied: true } } as const;
const skipped = { ok: true, value: { applied: false } } as const;
const notFound = { ok: false, reason: 'not_found' } as const;
const recorded = { recorded: true, attempts: 1 };

const row = (id: string, attempts = 0, generation = '0') =>
  ({ tenant_id: TENANT, execution_id: id, cancellation_attempts: attempts, cancellation_generation: generation });

beforeEach(() => {
  mocks.store.finaliseCancellation.mockReset();
  mocks.store.recordCancellationFailure.mockReset();
  mocks.client.query.mockClear();
  mocks.sql.length = 0;
});

describe('discovery', () => {
  it('returns an empty summary and touches nothing when no cancellation is due', async () => {
    const summary = await reconcileCancellations(poolWith([]), HOOKS, { instance: 'orch-1' });
    expect(summary).toEqual({ candidates: 0, applied: 0, skipped: 0, refused: 0, transient: 0, deferred: 0, systemic: 0, unrecorded: 0, halted: false });
    expect(mocks.store.finaliseCancellation).not.toHaveBeenCalled();
  });

  it('clamps the discovery limit to 1..50 and the timeouts to their bounds', async () => {
    const pool = poolWith([]);
    await reconcileCancellations(pool, HOOKS, { instance: 'orch-1', limit: 0, lockTimeoutMs: 1, statementTimeoutMs: 10_000_000 });
    expect((pool.query as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1]).toEqual([1]);
    await reconcileCancellations(poolWith([]), HOOKS, { instance: 'orch-1', limit: 999 });
    const pool2 = poolWith([]);
    await reconcileCancellations(pool2, HOOKS, { instance: 'orch-1', limit: 999.9 });
    expect((pool2.query as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1]).toEqual([50]);
  });

  it('uses the documented defaults when no bounds are given', async () => {
    const pool = poolWith([]);
    await reconcileCancellations(pool, HOOKS, { instance: 'orch-1' });
    expect((pool.query as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1]).toEqual([10]);
  });
});

describe('finalisation outcomes', () => {
  it('counts an applied cancellation and sets the bounded lock and statement timeouts', async () => {
    mocks.store.finaliseCancellation.mockResolvedValueOnce(applied);
    const summary = await reconcileCancellations(poolWith([row(EXEC_A)]), HOOKS,
      { instance: 'orch-1', lockTimeoutMs: 1500, statementTimeoutMs: 4000 });
    expect(summary).toMatchObject({ candidates: 1, applied: 1, halted: false });
    expect(mocks.sql).toContain('SET LOCAL lock_timeout = 1500');
    expect(mocks.sql).toContain('SET LOCAL statement_timeout = 4000');
    expect(mocks.store.finaliseCancellation).toHaveBeenCalledWith(TENANT, EXEC_A, 'orch-1');
    expect(mocks.store.recordCancellationFailure).not.toHaveBeenCalled();
  });

  it('counts a finalisation that found nothing to apply as skipped', async () => {
    mocks.store.finaliseCancellation.mockResolvedValueOnce(skipped);
    const summary = await reconcileCancellations(poolWith([row(EXEC_A)]), HOOKS, { instance: 'orch-1' });
    expect(summary).toMatchObject({ skipped: 1, applied: 0 });
  });

  it('records an execution the store refuses as execution_refused, using the discovery generation', async () => {
    mocks.store.finaliseCancellation.mockResolvedValueOnce(notFound);
    mocks.store.recordCancellationFailure.mockResolvedValueOnce(recorded);
    const summary = await reconcileCancellations(poolWith([row(EXEC_A, 3, '7')]), HOOKS, { instance: 'orch-1' });
    expect(mocks.store.recordCancellationFailure).toHaveBeenCalledWith(TENANT, EXEC_A, 'execution_refused', '7');
    expect(summary).toMatchObject({ refused: 1, halted: false });
  });

  it('classifies a transient database error as transient and records it at the same generation', async () => {
    mocks.store.finaliseCancellation.mockRejectedValueOnce(coded('40001'));
    mocks.store.recordCancellationFailure.mockResolvedValueOnce(recorded);
    const summary = await reconcileCancellations(poolWith([row(EXEC_A, 0)]), HOOKS, { instance: 'orch-1' });
    expect(mocks.store.recordCancellationFailure).toHaveBeenCalledWith(TENANT, EXEC_A, 'transient', '0');
    expect(summary).toMatchObject({ transient: 1, halted: false });
  });

  it('treats a row whose recording finds a stale generation as skipped, not failed', async () => {
    mocks.store.finaliseCancellation.mockRejectedValueOnce(coded('40001'));
    mocks.store.recordCancellationFailure.mockResolvedValueOnce({ recorded: false, attempts: 7 });
    const summary = await reconcileCancellations(poolWith([row(EXEC_A, 2, '4')]), HOOKS, { instance: 'orch-1' });
    expect(summary).toMatchObject({ skipped: 1, transient: 0 });
  });
});

describe('failure classification and halting', () => {
  it('halts the cycle on a systemic privilege fault and does not record it against the row', async () => {
    mocks.store.finaliseCancellation.mockRejectedValueOnce(coded('42501'));
    const summary = await reconcileCancellations(poolWith([row(EXEC_A), row(EXEC_B)]), HOOKS, { instance: 'orch-1' });
    expect(summary).toMatchObject({ candidates: 2, systemic: 1, halted: true });
    expect(mocks.store.recordCancellationFailure).not.toHaveBeenCalled();
    expect(mocks.store.finaliseCancellation).toHaveBeenCalledTimes(1);
  });

  it('halts the cycle when a failure cannot be recorded, because the database is not making progress', async () => {
    mocks.store.finaliseCancellation.mockRejectedValueOnce(coded('40001'));
    mocks.store.recordCancellationFailure.mockRejectedValueOnce(coded('XX000'));
    const summary = await reconcileCancellations(poolWith([row(EXEC_A), row(EXEC_B)]), HOOKS, { instance: 'orch-1' });
    expect(summary).toMatchObject({ unrecorded: 1, halted: true });
    expect(mocks.store.finaliseCancellation).toHaveBeenCalledTimes(1);
  });

  it('defers a row whose recording times out, without halting, so unrelated rows still progress', async () => {
    mocks.store.finaliseCancellation.mockRejectedValueOnce(coded('55P03')).mockResolvedValueOnce(applied);
    mocks.store.recordCancellationFailure.mockRejectedValueOnce(coded('55P03'));
    const summary = await reconcileCancellations(poolWith([row(EXEC_A), row(EXEC_B)]), HOOKS, { instance: 'orch-1' });
    expect(summary).toMatchObject({ deferred: 1, applied: 1, halted: false });
  });

  it('continues after an execution-specific failure and processes every remaining candidate', async () => {
    mocks.store.finaliseCancellation.mockRejectedValueOnce(coded('57014')).mockResolvedValueOnce(applied);
    mocks.store.recordCancellationFailure.mockResolvedValueOnce(recorded);
    const summary = await reconcileCancellations(poolWith([row(EXEC_A), row(EXEC_B)]), HOOKS, { instance: 'orch-1' });
    expect(summary).toMatchObject({ candidates: 2, transient: 1, applied: 1, halted: false });
  });

  it('counts the injected finalise fault as transient and the injected record fault as unrecorded', async () => {
    const injectFault = vi.fn((phase: 'finalise' | 'record') => (phase === 'finalise' ? coded('40001') : coded('XX000')));
    const summary = await reconcileCancellations(poolWith([row(EXEC_A)]), HOOKS, { instance: 'orch-1', injectFault });
    expect(summary).toMatchObject({ unrecorded: 1, halted: true });
    expect(injectFault).toHaveBeenCalledWith('finalise', TENANT, EXEC_A);
    expect(injectFault).toHaveBeenCalledWith('record', TENANT, EXEC_A);
    expect(mocks.store.finaliseCancellation).not.toHaveBeenCalled();
  });

  it('treats a non-error throw as transient rather than systemic', () => {
    expect(classifyFailure('boom')).toBe('transient');
    expect(classifyFailure(null)).toBe('transient');
    expect(classifyFailure({ code: 42 })).toBe('transient');
  });

  it('classifies configuration and authentication SQLSTATEs as systemic', () => {
    for (const code of ['42501', '42883', '42P01', '42703', '28000', '28P01', '3D000']) {
      expect(classifyFailure(coded(code))).toBe('systemic');
    }
    expect(classifyFailure(coded('40P01'))).toBe('transient');
  });
});

describe('retry policy constants', () => {
  it('documents a 1 s initial backoff, a 60 s cap and 1000 stored attempts', () => {
    expect(CANCELLATION_RETRY).toEqual({ initialBackoffSeconds: 1, maxBackoffSeconds: 60, maxStoredAttempts: 1000 });
  });
});

describe('backlog mapping', () => {
  it('maps the aggregate row to camelCase and rounds the oldest request age to whole seconds', async () => {
    const pool = { query: vi.fn(async () => ({ rows: [{ pending: 4, overdue: 2, failing: 1, max_attempts: 9, oldest_request_age_seconds: 12.6 }] })) } as unknown as Pool;
    await expect(readCancellationBacklog(pool)).resolves.toEqual({
      pending: 4, overdue: 2, failing: 1, maxAttempts: 9, oldestRequestAgeSeconds: 13,
    });
  });

  it('reports an empty backlog as zeros', async () => {
    const pool = { query: vi.fn(async () => ({ rows: [{ pending: 0, overdue: 0, failing: 0, max_attempts: 0, oldest_request_age_seconds: 0 }] })) } as unknown as Pool;
    await expect(readCancellationBacklog(pool)).resolves.toEqual({
      pending: 0, overdue: 0, failing: 0, maxAttempts: 0, oldestRequestAgeSeconds: 0,
    });
  });
});

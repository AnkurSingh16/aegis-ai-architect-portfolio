import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { TenantRunner } from '../security/tool-approval-store.js';
import { GatewayError, INVESTIGATION_LIMITS, INVESTIGATION_SCOPES, type Principal, principalDigest, readInvestigation,
  requestCancellation, submitInvestigation, validateQuestion } from './gateway.js';

const NORTH = '10000000-0000-4000-8000-000000000001';
const EXECUTION = '30000000-0000-4000-8000-000000000003';
const KEY = '40000000-0000-4000-8000-000000000004';
const ISSUER = 'https://issuer.synthetic.test';
const owner: Principal = { issuer: ISSUER, subject: 'reader-north', scopes: new Set(['read:cases']) };
const stranger: Principal = { issuer: ISSUER, subject: 'reader-other', scopes: new Set(['read:cases']) };

type Row = Record<string, unknown>;
type Responder = (sql: string, values: unknown[]) => { rows: Row[]; rowCount: number | null };

/** A tenant runner that records every statement and answers from a script. No database is involved. */
function scriptedRunner(respond: Responder) {
  const calls: Array<{ sql: string; values: unknown[] }> = [];
  let runs = 0;
  const query = async (sql: string, values: readonly unknown[]) => {
    calls.push({ sql, values: [...values] });
    return respond(sql, [...values]);
  };
  const run = (async (_tenantId: string, operation: (client: { query: typeof query }) => Promise<unknown>) => {
    runs += 1;
    return operation({ query });
  }) as unknown as TenantRunner;
  return { run, calls, runs: () => runs };
}

const membership = (role: string): Responder => (sql) => (sql.includes('aegis.memberships')
  ? { rows: [{ role }], rowCount: 1 } : { rows: [], rowCount: 0 });

const digestOf = (principal: Principal) => principalDigest(principal.issuer, principal.subject);
const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

describe('question validation', () => {
  it('normalises and trims a valid question', () => {
    expect(validateQuestion('  Which procedure applies?\n ')).toBe('Which procedure applies?');
    expect(validateQuestion('Ｔｅｓｔ')).toBe('Test');
  });
  it('rejects non-strings, empty input, oversized input and control characters', () => {
    for (const value of [undefined, 1, null, '   ', 'a'.repeat(1001), 'bad\u0000text', 'bell\u0007', 'del\u007f']) {
      expect(() => validateQuestion(value)).toThrow(GatewayError);
    }
  });
  it('keeps tabs and newlines as ordinary whitespace', () => {
    expect(validateQuestion('line one\nline\ttwo')).toBe('line one\nline\ttwo');
  });
});

describe('principal digest', () => {
  it('is deterministic and bound to both issuer and subject', () => {
    expect(principalDigest(ISSUER, 'a')).toBe(principalDigest(ISSUER, 'a'));
    expect(principalDigest(ISSUER, 'a')).not.toBe(principalDigest(ISSUER, 'b'));
    expect(principalDigest(ISSUER, 'a')).not.toBe(principalDigest('https://other.test', 'a'));
    expect(principalDigest(ISSUER, 'reader-north')).toMatch(/^[0-9a-f]{64}$/);
    expect(principalDigest(ISSUER, 'reader-north')).not.toContain('reader-north');
  });
});

describe('submitInvestigation', () => {
  it('refuses a principal without the read scope before touching the database', async () => {
    const script = scriptedRunner(membership('reader'));
    const noScope: Principal = { ...owner, scopes: new Set(['case:read']) };
    await expect(submitInvestigation(script.run, noScope, { tenantId: NORTH, idempotencyKey: KEY, question: 'q' }))
      .rejects.toMatchObject({ code: 'forbidden' });
    expect(script.runs()).toBe(0);
  });

  it('rejects malformed tenant and idempotency identifiers', async () => {
    const script = scriptedRunner(membership('reader'));
    await expect(submitInvestigation(script.run, owner, { tenantId: 'north', idempotencyKey: KEY, question: 'q' }))
      .rejects.toMatchObject({ code: 'invalid_request' });
    await expect(submitInvestigation(script.run, owner, { tenantId: NORTH, idempotencyKey: 'not-a-uuid', question: 'q' }))
      .rejects.toMatchObject({ code: 'invalid_request' });
    expect(script.runs()).toBe(0);
  });

  it('refuses a principal with no membership in the tenant, and writes nothing', async () => {
    const script = scriptedRunner(() => ({ rows: [], rowCount: 0 }));
    await expect(submitInvestigation(script.run, owner, { tenantId: NORTH, idempotencyKey: KEY, question: 'q' }))
      .rejects.toMatchObject({ code: 'forbidden' });
    expect(script.calls.some((c) => /INSERT/i.test(c.sql))).toBe(false);
  });

  it('creates the execution with the server-side scope ceiling and the principal digest, never request-supplied values', async () => {
    const script = scriptedRunner((sql) => {
      if (sql.includes('aegis.memberships')) return { rows: [{ role: 'reader' }], rowCount: 1 };
      if (sql.includes('INSERT INTO aegis.agent_executions')) return { rows: [{ execution_id: EXECUTION }], rowCount: 1 };
      return { rows: [], rowCount: 1 };
    });
    const result = await submitInvestigation(script.run, owner, { tenantId: NORTH, idempotencyKey: KEY,
      question: '  Which procedure applies?  ' });
    expect(result).toEqual({ executionId: EXECUTION, created: true });
    const execution = script.calls.find((c) => c.sql.includes('INSERT INTO aegis.agent_executions'));
    expect(execution?.values[2]).toBe(digestOf(owner));
    expect(execution?.values[3]).toEqual([...INVESTIGATION_SCOPES]);
    expect(execution?.values.slice(4)).toEqual([INVESTIGATION_LIMITS.maxDepth, INVESTIGATION_LIMITS.maxDelegations,
      INVESTIGATION_LIMITS.maxSteps, INVESTIGATION_LIMITS.grantTtlSeconds, INVESTIGATION_LIMITS.maxAttempts]);
    const request = script.calls.find((c) => c.sql.includes('INSERT INTO aegis.investigation_requests'));
    expect(request?.values[2]).toBe('Which procedure applies?');
    expect(request?.values[3]).toBe(createHash('sha256').update('Which procedure applies?', 'utf8').digest('hex'));
    expect(script.calls.some((c) => c.sql.includes("'execution_created'"))).toBe(true);
  });

  it('returns the same execution on an idempotent retry by the same principal, and writes no second request', async () => {
    const script = scriptedRunner((sql) => {
      if (sql.includes('aegis.memberships')) return { rows: [{ role: 'operator' }], rowCount: 1 };
      if (sql.includes('INSERT INTO aegis.agent_executions')) return { rows: [], rowCount: 0 };
      return { rows: [{ execution_id: EXECUTION, principal_ref: digestOf(owner), question_digest: sha256('q') }], rowCount: 1 };
    });
    expect(await submitInvestigation(script.run, owner, { tenantId: NORTH, idempotencyKey: KEY, question: 'q' }))
      .toEqual({ executionId: EXECUTION, created: false });
    expect(script.calls.some((c) => c.sql.includes('INSERT INTO aegis.investigation_requests'))).toBe(false);
  });

  it('refuses an idempotency key replayed with a different question instead of returning the first execution', async () => {
    const script = scriptedRunner((sql) => {
      if (sql.includes('aegis.memberships')) return { rows: [{ role: 'operator' }], rowCount: 1 };
      if (sql.includes('INSERT INTO aegis.agent_executions')) return { rows: [], rowCount: 0 };
      return { rows: [{ execution_id: EXECUTION, principal_ref: digestOf(owner), question_digest: sha256('the original question') }], rowCount: 1 };
    });
    await expect(submitInvestigation(script.run, owner, { tenantId: NORTH, idempotencyKey: KEY, question: 'a different question' }))
      .rejects.toMatchObject({ code: 'idempotency_conflict' });
    expect(script.calls.some((c) => c.sql.includes('INSERT INTO aegis.investigation_requests'))).toBe(false);
  });

  it('refuses reuse of an idempotency key by a different principal', async () => {
    const script = scriptedRunner((sql) => {
      if (sql.includes('aegis.memberships')) return { rows: [{ role: 'reader' }], rowCount: 1 };
      if (sql.includes('INSERT INTO aegis.agent_executions')) return { rows: [], rowCount: 0 };
      return { rows: [{ execution_id: EXECUTION, principal_ref: digestOf(owner) }], rowCount: 1 };
    });
    await expect(submitInvestigation(script.run, stranger, { tenantId: NORTH, idempotencyKey: KEY, question: 'q' }))
      .rejects.toMatchObject({ code: 'idempotency_conflict' });
  });

  it('reports unavailable when a conflicting key cannot be read back', async () => {
    const script = scriptedRunner((sql) => (sql.includes('aegis.memberships') ? { rows: [{ role: 'reader' }], rowCount: 1 }
      : { rows: [], rowCount: 0 }));
    await expect(submitInvestigation(script.run, owner, { tenantId: NORTH, idempotencyKey: KEY, question: 'q' }))
      .rejects.toMatchObject({ code: 'unavailable' });
  });
});

describe('readInvestigation', () => {
  const row = (principalRef: string, status = 'running') => ({ workflow_stage: 'review', status, cancel_requested: false,
    principal_ref: principalRef });

  it('reports another principal’s execution as not found without disclosing it', async () => {
    const script = scriptedRunner((sql) => (sql.includes('aegis.memberships') ? { rows: [{ role: 'reader' }], rowCount: 1 }
      : sql.includes('FROM aegis.agent_executions') ? { rows: [row(digestOf(owner))], rowCount: 1 } : { rows: [], rowCount: 0 }));
    await expect(readInvestigation(script.run, stranger, { tenantId: NORTH, executionId: EXECUTION }))
      .rejects.toMatchObject({ code: 'not_found' });
    expect(script.calls.some((c) => c.sql.includes('investigation_results'))).toBe(false);
  });

  it('reports a missing execution as not found', async () => {
    const script = scriptedRunner((sql) => (sql.includes('aegis.memberships') ? { rows: [{ role: 'reader' }], rowCount: 1 }
      : { rows: [], rowCount: 0 }));
    await expect(readInvestigation(script.run, owner, { tenantId: NORTH, executionId: EXECUTION }))
      .rejects.toMatchObject({ code: 'not_found' });
  });

  it('returns the owner’s stage and a null result while no result is stored', async () => {
    const script = scriptedRunner((sql) => (sql.includes('aegis.memberships') ? { rows: [{ role: 'reader' }], rowCount: 1 }
      : sql.includes('FROM aegis.agent_executions') ? { rows: [row(digestOf(owner))], rowCount: 1 } : { rows: [], rowCount: 0 }));
    expect(await readInvestigation(script.run, owner, { tenantId: NORTH, executionId: EXECUTION })).toEqual({
      executionId: EXECUTION, stage: 'review', status: 'running', cancelRequested: false, result: null });
  });

  it('maps a stored result for the owner, including a refusal with its reason', async () => {
    const script = scriptedRunner((sql) => {
      if (sql.includes('aegis.memberships')) return { rows: [{ role: 'reader' }], rowCount: 1 };
      if (sql.includes('FROM aegis.agent_executions')) return { rows: [row(digestOf(owner), 'succeeded')], rowCount: 1 };
      return { rows: [{ verdict: 'insufficient', answer: null, citations: [], reviewer_decision: 'rejected',
        failure_reason: 'no_supported_evidence' }], rowCount: 1 };
    });
    const view = await readInvestigation(script.run, owner, { tenantId: NORTH, executionId: EXECUTION });
    expect(view.result).toEqual({ verdict: 'insufficient', answer: null, citations: [], reviewerDecision: 'rejected',
      failureReason: 'no_supported_evidence' });
  });

  it('requires the read scope and well-formed identifiers', async () => {
    const script = scriptedRunner(membership('reader'));
    await expect(readInvestigation(script.run, { ...owner, scopes: new Set() }, { tenantId: NORTH, executionId: EXECUTION }))
      .rejects.toMatchObject({ code: 'forbidden' });
    await expect(readInvestigation(script.run, owner, { tenantId: NORTH, executionId: 'x' }))
      .rejects.toMatchObject({ code: 'invalid_request' });
  });
});

describe('requestCancellation', () => {
  const execution = (principalRef: string, status: string) => (sql: string) => (sql.includes('aegis.memberships')
    ? { rows: [{ role: 'reader' }], rowCount: 1 }
    : sql.includes('SELECT principal_ref, status') ? { rows: [{ principal_ref: principalRef, status }], rowCount: 1 }
      : { rows: [], rowCount: 1 });

  it('rejects reasons outside the allowed vocabulary', async () => {
    const script = scriptedRunner(execution(digestOf(owner), 'running'));
    for (const reason of ['', 'Stop Now', 'a'.repeat(41), "x'; DROP TABLE aegis.agent_executions; --"]) {
      await expect(requestCancellation(script.run, owner, { tenantId: NORTH, executionId: EXECUTION, reason }))
        .rejects.toMatchObject({ code: 'invalid_request' });
    }
  });

  it('does not let another principal cancel the execution, and changes nothing', async () => {
    const script = scriptedRunner(execution(digestOf(owner), 'running'));
    await expect(requestCancellation(script.run, stranger, { tenantId: NORTH, executionId: EXECUTION, reason: 'user_cancelled' }))
      .rejects.toMatchObject({ code: 'not_found' });
    expect(script.calls.some((c) => c.sql.startsWith('UPDATE'))).toBe(false);
  });

  it('does not change a finished execution', async () => {
    for (const status of ['succeeded', 'failed', 'cancelled']) {
      const script = scriptedRunner(execution(digestOf(owner), status));
      expect(await requestCancellation(script.run, owner, { tenantId: NORTH, executionId: EXECUTION, reason: 'user_cancelled' }))
        .toEqual({ accepted: false });
      expect(script.calls.some((c) => c.sql.startsWith('UPDATE'))).toBe(false);
    }
  });

  it('records the cancellation request for the owner of a running execution', async () => {
    const script = scriptedRunner(execution(digestOf(owner), 'running'));
    expect(await requestCancellation(script.run, owner, { tenantId: NORTH, executionId: EXECUTION, reason: 'user_cancelled' }))
      .toEqual({ accepted: true });
    const update = script.calls.find((c) => c.sql.startsWith('UPDATE aegis.agent_executions'));
    expect(update?.sql).toContain('cancel_requested = true');
    expect(update?.values).toEqual([EXECUTION, NORTH, 'user_cancelled']);
  });
});

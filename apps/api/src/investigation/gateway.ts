import { createHash } from 'node:crypto';
import type { TenantQueryable, TenantRunner } from '../security/tool-approval-store.js';
import { limits } from './contracts.js';

/**
 * The investigation gateway: the only path by which an investigation is created or read. It runs under the aegis_gateway role. The
 * caller is the authenticated API, which has already verified the access token. This module then:
 * - checks the verified principal's tenant membership in the database (memberships are read here, never trusted from the request);
 * - derives the principal digest from the verified issuer and subject (the raw subject is not stored);
 * - records the principal's scopes from the fixed ceiling for investigations, never from the request;
 * - creates the execution with the idempotency key in the same transaction as the question record;
 * - returns results and cancellation only to the originating principal.
 * Nothing here accepts a principal, tenant or scope from a request body.
 */

export class GatewayError extends Error {
  constructor(readonly code: 'forbidden' | 'invalid_request' | 'idempotency_conflict' | 'not_found' | 'unavailable') { super(code); }
}

export interface Principal { readonly issuer: string; readonly subject: string; readonly scopes: ReadonlySet<string> }

/** The scopes an investigation runs with. A ceiling fixed here, not a copy of the request. */
export const INVESTIGATION_SCOPES = ['case:read', 'document:read'] as const;
export const INVESTIGATION_LIMITS = Object.freeze({ maxDepth: 2, maxDelegations: 3, maxSteps: 12, grantTtlSeconds: 300, maxAttempts: 10 });

export function principalDigest(issuer: string, subject: string): string {
  return createHash('sha256').update(`principal-v1|${issuer}|${subject}`, 'utf8').digest('hex');
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function validateQuestion(value: unknown): string {
  if (typeof value !== 'string') throw new GatewayError('invalid_request');
  const question = value.normalize('NFKC').trim();
  if (question.length < 1 || question.length > limits.questionChars) throw new GatewayError('invalid_request');
  if ([...question].some((c) => { const code = c.codePointAt(0) ?? 0; return (code < 0x20 && code !== 0x0a && code !== 0x09) || code === 0x7f; })) {
    throw new GatewayError('invalid_request');
  }
  return question;
}

async function membershipRole(client: TenantQueryable, principal: Principal, tenantId: string): Promise<'reader' | 'operator'> {
  const row = (await client.query<{ role: string }>(
    'SELECT role FROM aegis.memberships WHERE issuer = $1 AND subject = $2 AND tenant_id = $3', [principal.issuer, principal.subject, tenantId])).rows[0];
  if (row?.role !== 'reader' && row?.role !== 'operator') throw new GatewayError('forbidden');
  return row.role;
}

function requireRead(principal: Principal): void {
  if (!principal.scopes.has('read:cases')) throw new GatewayError('forbidden');
}

export interface SubmitResult { readonly executionId: string; readonly created: boolean }

export async function submitInvestigation(run: TenantRunner, principal: Principal, input: {
  tenantId: string; idempotencyKey: string; question: unknown;
}): Promise<SubmitResult> {
  requireRead(principal);
  if (!UUID.test(input.tenantId) || !UUID.test(input.idempotencyKey)) throw new GatewayError('invalid_request');
  const question = validateQuestion(input.question);
  const digest = principalDigest(principal.issuer, principal.subject);
  const questionDigest = createHash('sha256').update(question, 'utf8').digest('hex');
  return run(input.tenantId, async (client) => {
    await membershipRole(client, principal, input.tenantId);
    const inserted = await client.query<{ execution_id: string }>(
      `INSERT INTO aegis.agent_executions (tenant_id, idempotency_key, principal_ref, principal_scopes, root_agent, max_depth,
         max_delegations, max_steps, grant_ttl_seconds, max_attempts)
       VALUES ($1, $2, $3, $4, 'orchestrator', $5, $6, $7, $8, $9)
       ON CONFLICT (tenant_id, idempotency_key) DO NOTHING RETURNING execution_id`,
      [input.tenantId, input.idempotencyKey, digest, [...INVESTIGATION_SCOPES], INVESTIGATION_LIMITS.maxDepth,
        INVESTIGATION_LIMITS.maxDelegations, INVESTIGATION_LIMITS.maxSteps, INVESTIGATION_LIMITS.grantTtlSeconds, INVESTIGATION_LIMITS.maxAttempts]);
    if (inserted.rows.length === 0) {
      // Idempotent retry. The same key from the same principal returns the same execution. Another principal cannot reuse it.
      const existing = (await client.query<{ execution_id: string; principal_ref: string }>(
        `SELECT e.execution_id, e.principal_ref, r.question_digest
           FROM aegis.agent_executions e
           LEFT JOIN aegis.investigation_requests r ON r.execution_id = e.execution_id AND r.tenant_id = e.tenant_id
          WHERE e.tenant_id = $1 AND e.idempotency_key = $2`,
        [input.tenantId, input.idempotencyKey])).rows[0] as ({ execution_id: string; principal_ref: string; question_digest: string | null } | undefined);
      if (!existing) throw new GatewayError('unavailable');
      // The same key must come from the same principal AND carry the same question. Anything else is a conflicting request, not a replay.
      if (existing.principal_ref !== digest) throw new GatewayError('idempotency_conflict');
      if (existing.question_digest !== questionDigest) throw new GatewayError('idempotency_conflict');
      return { executionId: existing.execution_id, created: false };
    }
    const executionId = inserted.rows[0].execution_id;
    await client.query(
      `INSERT INTO aegis.investigation_requests (execution_id, tenant_id, question, question_digest, principal_ref)
       VALUES ($1, $2, $3, $4, $5)`,
      [executionId, input.tenantId, question, questionDigest, digest]);
    await client.query(
      `INSERT INTO aegis.agent_execution_events (tenant_id, execution_id, event_type, outcome, reason, fencing_token)
       VALUES ($1, $2, 'execution_created', 'accepted', NULL, 0)`, [input.tenantId, executionId]);
    return { executionId, created: true };
  });
}

export interface InvestigationView {
  readonly executionId: string;
  readonly stage: string;
  readonly status: string;
  readonly cancelRequested: boolean;
  readonly result: null | { readonly verdict: string; readonly answer: string | null;
    readonly citations: unknown; readonly reviewerDecision: string; readonly failureReason: string | null };
}

export async function readInvestigation(run: TenantRunner, principal: Principal, input: { tenantId: string; executionId: string }): Promise<InvestigationView> {
  requireRead(principal);
  if (!UUID.test(input.tenantId) || !UUID.test(input.executionId)) throw new GatewayError('invalid_request');
  const digest = principalDigest(principal.issuer, principal.subject);
  return run(input.tenantId, async (client) => {
    await membershipRole(client, principal, input.tenantId);
    const row = (await client.query<{ workflow_stage: string; status: string; cancel_requested: boolean; principal_ref: string }>(
      'SELECT workflow_stage, status, cancel_requested, principal_ref FROM aegis.agent_executions WHERE execution_id = $1 AND tenant_id = $2',
      [input.executionId, input.tenantId])).rows[0];
    // Another principal's execution is reported as not found, so existence is not disclosed.
    if (!row || row.principal_ref !== digest) throw new GatewayError('not_found');
    const result = (await client.query<{ verdict: string; answer: string | null; citations: unknown; reviewer_decision: string; failure_reason: string | null }>(
      'SELECT verdict, answer, citations, reviewer_decision, failure_reason FROM aegis.investigation_results WHERE execution_id = $1',
      [input.executionId])).rows[0];
    return { executionId: input.executionId, stage: row.workflow_stage, status: row.status, cancelRequested: row.cancel_requested,
      result: result ? { verdict: result.verdict, answer: result.answer, citations: result.citations, reviewerDecision: result.reviewer_decision,
        failureReason: result.failure_reason } : null };
  });
}

/**
 * The gateway records a cancellation request. It never finalises a cancellation: the orchestrator does (migrations 024 and 025), with or
 * without a live lease. The gateway's database role may set cancel_requested and nothing else on the execution (migration 018).
 *
 * The request is one conditional UPDATE bound to the verified principal, the tenant, and a non-terminal, not-yet-requested row. Under
 * READ COMMITTED a concurrent finalisation makes the UPDATE match nothing, and the re-read then reports the committed terminal state.
 * The request event is written only by the transition that set the flag, so repeated requests are idempotent.
 */
export async function requestCancellation(run: TenantRunner, principal: Principal, input: { tenantId: string; executionId: string; reason: string }):
  Promise<{ accepted: boolean; state: 'cancel_requested' | 'already_requested' | 'terminal' }> {
  requireRead(principal);
  if (!UUID.test(input.tenantId) || !UUID.test(input.executionId)) throw new GatewayError('invalid_request');
  if (!/^[a-z_]{1,40}$/.test(input.reason)) throw new GatewayError('invalid_request');
  const digest = principalDigest(principal.issuer, principal.subject);
  return run(input.tenantId, async (client) => {
    await membershipRole(client, principal, input.tenantId);
    const owned = (await client.query<{ principal_ref: string; status: string }>(
      'SELECT principal_ref, status FROM aegis.agent_executions WHERE execution_id = $1 AND tenant_id = $2', [input.executionId, input.tenantId])).rows[0];
    if (!owned || owned.principal_ref !== digest) throw new GatewayError('not_found');
    if (['succeeded', 'failed', 'cancelled'].includes(owned.status)) return { accepted: false, state: 'terminal' as const };
    const transitioned = await client.query<{ execution_id: string }>(
      `UPDATE aegis.agent_executions SET cancel_requested = true, cancel_reason = COALESCE(cancel_reason, $3),
          version = version + 1, updated_at = clock_timestamp()
        WHERE execution_id = $1 AND tenant_id = $2 AND principal_ref = $4 AND NOT cancel_requested
          AND status NOT IN ('succeeded', 'failed', 'cancelled')
        RETURNING execution_id`,
      [input.executionId, input.tenantId, input.reason, digest]);
    if (transitioned.rows.length === 1) {
      await client.query(`INSERT INTO aegis.agent_execution_events (tenant_id, execution_id, event_type, outcome, reason, actor_agent,
          actor_instance) VALUES ($1, $2, 'cancel_requested', 'accepted', 'requested', NULL, $3)`, [input.tenantId, input.executionId, digest]);
      return { accepted: true, state: 'cancel_requested' as const };
    }
    // Nothing changed: either a request already exists, or the execution became terminal under a concurrent write. Re-read the committed row.
    const now = (await client.query<{ status: string }>(
      'SELECT status FROM aegis.agent_executions WHERE execution_id = $1 AND tenant_id = $2', [input.executionId, input.tenantId])).rows[0];
    if (!now || ['succeeded', 'failed', 'cancelled'].includes(now.status)) return { accepted: false, state: 'terminal' as const };
    return { accepted: true, state: 'already_requested' as const };
  });
}

import type { TenantQueryable } from '../../security/tool-approval-store.js';
import { createAgentExecutionStore, joinTransaction, type ExecutionHooks, type Fence } from '../persistence/execution-store.js';
import { ACTIONS, limits, validateBundle, validatePlan, validateReview, type Candidate, type EvidenceBundle } from '../../investigation/contracts.js';
import { planFromQuestion } from '../../investigation/triage.js';
import { retrieveEvidence } from '../../investigation/evidence.js';
import { composeCandidate, reviewCandidate } from '../../investigation/review.js';
import { dispatchStepInTx, setStageInTx, RETRIEVAL_AGENT, REVIEWER_AGENT, ROOT_AGENT, TRIAGE_AGENT, WORKFLOW_SCOPES } from './workflow.js';
import { recordMessageEvent } from './outbox.js';

/**
 * Per-agent behaviour. Each handler runs inside the receive transaction of one inbound message, so its effect and the receipt commit
 * together. Requests are handled by the agent that received them. Results are handled only by the orchestrator, which owns the stage
 * machine and decides what each result means. No handler reads authority from the message.
 */

export class TransientRefusal extends Error {
  constructor(readonly reason: string) { super(reason); }
}

export interface RequestEffect {
  /** The typed result payload to return to the root agent. */
  readonly result: Record<string, unknown>;
  readonly resultAction: string;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const sameKeys = (v: Record<string, unknown>, keys: string[]) => Object.keys(v).sort().join(',') === [...keys].sort().join(',');

/** Typed argument parsers. Any other shape is refused. */
export function parseTriageArguments(value: unknown): { question: string } | null {
  if (!isObject(value) || !sameKeys(value, ['question'])) return null;
  if (typeof value.question !== 'string' || value.question.length < 1 || value.question.length > limits.questionChars) return null;
  return { question: value.question };
}
export function parseRetrievalArguments(value: unknown): { query: string; topK: number } | null {
  if (!isObject(value) || !sameKeys(value, ['query', 'topK'])) return null;
  if (typeof value.query !== 'string' || value.query.length < 1 || value.query.length > limits.queryChars) return null;
  if (!Number.isInteger(value.topK) || (value.topK as number) < 1 || (value.topK as number) > limits.topK) return null;
  return { query: value.query, topK: value.topK as number };
}
export function parseReviewArguments(value: unknown): { question: string; answer: string; claims: Array<{ text: string; ref: string }>;
  evidence: Array<{ ref: string; excerpt: string }> } | null {
  if (!isObject(value) || !sameKeys(value, ['question', 'answer', 'claims', 'evidence'])) return null;
  if (typeof value.question !== 'string' || typeof value.answer !== 'string' || !Array.isArray(value.claims) || !Array.isArray(value.evidence)) return null;
  const claims = value.claims.map((c) => (isObject(c) && typeof c.text === 'string' && typeof c.ref === 'string' ? { text: c.text, ref: c.ref } : null));
  const evidence = value.evidence.map((e) => (isObject(e) && typeof e.ref === 'string' && typeof e.excerpt === 'string' ? { ref: e.ref, excerpt: e.excerpt } : null));
  if (claims.some((c) => c === null) || evidence.some((e) => e === null)) return null;
  return { question: value.question, answer: value.answer, claims: claims as Array<{ text: string; ref: string }>,
    evidence: evidence as Array<{ ref: string; excerpt: string }> };
}

/** Requests: the receiving agent produces its typed result. Retrieval reads the tenant's documents under its own role. */
export async function handleRequest(client: TenantQueryable, input: { receiver: string; tenantId: string; payload: Record<string, unknown> }):
  Promise<RequestEffect | { refused: string }> {
  const args = input.payload.arguments;
  if (input.receiver === TRIAGE_AGENT) {
    const parsed = parseTriageArguments(args);
    if (!parsed) return { refused: 'invalid_arguments' };
    return { result: { plan: planFromQuestion(parsed.question) }, resultAction: ACTIONS.planResult };
  }
  if (input.receiver === RETRIEVAL_AGENT) {
    const parsed = parseRetrievalArguments(args);
    if (!parsed) return { refused: 'invalid_arguments' };
    const evidence = await retrieveEvidence(client, input.tenantId, parsed.query, parsed.topK);
    return { result: { evidence }, resultAction: ACTIONS.retrieveResult };
  }
  if (input.receiver === REVIEWER_AGENT) {
    const parsed = parseReviewArguments(args);
    if (!parsed) return { refused: 'invalid_arguments' };
    const review = reviewCandidate({ question: parsed.question, answer: parsed.answer, claims: parsed.claims, evidence: parsed.evidence });
    return { result: { review }, resultAction: ACTIONS.reviewResult };
  }
  return { refused: 'unexpected_message_kind' };
}

const EXPECTED_STAGE: Record<string, string> = {
  [TRIAGE_AGENT]: 'triage_requested',
  [RETRIEVAL_AGENT]: 'retrieval_requested',
  [REVIEWER_AGENT]: 'review_requested',
};

export interface AdvanceContext {
  readonly client: TenantQueryable;
  readonly hooks: ExecutionHooks;
  readonly tenantId: string;
  readonly executionId: string;
  readonly sender: string;
  readonly payload: Record<string, unknown>;
  readonly orchestrator: { readonly spiffeId: string; readonly instance: string };
}

export type AdvanceEffect = { readonly effect: 'advanced' | 'finalised' | 'cancelled' | 'discarded'; readonly reason?: string };

/**
 * The orchestrator's response to one result. It takes the lease through the P4 claim, so it runs under the same fencing as every other
 * orchestrator decision; then it validates the typed result, moves the stage (the database checks the transition) and either dispatches
 * the next step or finalises the investigation. A result that does not match the expected stage is refused.
 */
export async function advanceOnResult(ctx: AdvanceContext): Promise<AdvanceEffect> {
  const { client, tenantId, executionId } = ctx;
  const row = (await client.query<{ workflow_stage: string; status: string }>(
    'SELECT workflow_stage, status FROM aegis.agent_executions WHERE execution_id = $1', [executionId])).rows[0];
  if (!row) throw new TransientRefusal('not_found');
  const expected = EXPECTED_STAGE[ctx.sender];
  if (!expected) return { effect: 'discarded', reason: 'unexpected_sender' };
  if (row.workflow_stage !== expected) {
    if (['completed', 'insufficient_evidence', 'failed', 'cancelled'].includes(row.workflow_stage)) return { effect: 'discarded', reason: row.workflow_stage };
    throw new TransientRefusal('unexpected_stage');
  }

  const store = createAgentExecutionStore(joinTransaction(client, tenantId), ctx.hooks);
  const claim = await store.claim({ tenantId, executionId, spiffeId: ctx.orchestrator.spiffeId, instance: ctx.orchestrator.instance, leaseSeconds: 60 });
  if (!claim.ok) {
    // A cancellation requested earlier is applied by the claim itself (status and stage become cancelled). A lease held elsewhere is
    // transient: the result is not consumed, and the sender retries.
    if (claim.reason === 'cancel_requested') return { effect: 'cancelled', reason: 'cancel_requested' };
    if (claim.reason === 'retries_exhausted') return { effect: 'discarded', reason: 'retries_exhausted' };
    throw new TransientRefusal(claim.reason);
  }
  const fence: Fence = { tenantId, executionId, agentId: claim.value.agentId, instance: ctx.orchestrator.instance, fencingToken: claim.value.fencingToken };

  const fail = async (reason: string): Promise<AdvanceEffect> => {
    await setStageInTx(client, executionId, 'failed');
    await finalise(client, tenantId, executionId, { verdict: 'failed', answer: null, citations: [], reviewerDecision: 'not_reviewed', failureReason: reason });
    await store.release(fence, 'failed', reason);
    return { effect: 'finalised', reason };
  };
  const dispatch = async (to: string, nextStage: string, args: Record<string, unknown>, action: string, resultAction: string, scopes: readonly string[]) =>
    dispatchStepInTx(client, ctx.hooks, { tenantId, fence, to, requestedScopes: [...scopes], action, resultAction, arguments: args, nextStage });

  if (ctx.sender === TRIAGE_AGENT) {
    const question = (await client.query<{ question: string }>('SELECT question FROM aegis.investigation_requests WHERE execution_id = $1',
      [executionId])).rows[0]?.question;
    const planned = validatePlan(ctx.payload.plan, question ?? '');
    if (!planned.ok || !question) return fail(planned.ok ? 'invalid_plan' : planned.reason);
    await setStageInTx(client, executionId, 'plan_received');
    if (!planned.plan.retrieve) {
      await setStageInTx(client, executionId, 'insufficient_evidence');
      await finalise(client, tenantId, executionId, { verdict: 'insufficient_evidence', answer: null, citations: [], reviewerDecision: 'not_reviewed', failureReason: null });
      await store.release(fence, 'succeeded', 'no_retrieval_planned');
      return { effect: 'finalised', reason: 'no_retrieval_planned' };
    }
    const step = await dispatch(RETRIEVAL_AGENT, 'retrieval_requested', { query: planned.plan.query, topK: limits.topK },
      ACTIONS.retrieve, ACTIONS.retrieveResult, WORKFLOW_SCOPES);
    if (!step.ok) return fail(step.reason);
    return { effect: 'advanced' };
  }

  if (ctx.sender === RETRIEVAL_AGENT) {
    const bundled = validateBundle(ctx.payload.evidence);
    if (!bundled.ok) return fail(bundled.reason);
    const bundle: EvidenceBundle = bundled.bundle;
    if (bundle.status === 'insufficient') {
      await setStageInTx(client, executionId, 'insufficient_evidence');
      await finalise(client, tenantId, executionId, { verdict: 'insufficient_evidence', answer: null, citations: [], reviewerDecision: 'not_reviewed', failureReason: null });
      await store.release(fence, 'succeeded', 'insufficient_evidence');
      return { effect: 'finalised', reason: 'insufficient_evidence' };
    }
    const question = (await client.query<{ question: string }>('SELECT question FROM aegis.investigation_requests WHERE execution_id = $1',
      [executionId])).rows[0]?.question ?? '';
    const candidate: Candidate = composeCandidate(bundle);
    if (candidate.answer.length === 0) return fail('no_candidate');
    await setStageInTx(client, executionId, 'evidence_received');
    await client.query(`INSERT INTO aegis.investigation_candidates (execution_id, tenant_id, answer, claims) VALUES ($1, $2, $3, $4::jsonb)`,
      [executionId, tenantId, candidate.answer, JSON.stringify(candidate.claims)]);
    const step = await dispatch(REVIEWER_AGENT, 'review_requested', { question, answer: candidate.answer, claims: candidate.claims,
      evidence: bundle.items.map((i) => ({ ref: i.ref, excerpt: i.excerpt })) }, ACTIONS.review, ACTIONS.reviewResult, WORKFLOW_SCOPES);
    if (!step.ok) return fail(step.reason);
    return { effect: 'advanced' };
  }

  // Reviewer: the only path to an answer. The candidate used is the one recorded before review was requested.
  const reviewed = validateReview(ctx.payload.review);
  if (!reviewed.ok) return fail(reviewed.reason);
  const candidate = (await client.query<{ answer: string; claims: Array<{ text: string; ref: string }> }>(
    'SELECT answer, claims FROM aegis.investigation_candidates WHERE execution_id = $1', [executionId])).rows[0];
  if (!candidate) return fail('no_candidate');
  const decision = reviewed.review.decision;
  await setStageInTx(client, executionId, 'review_received');
  if (decision === 'approve') {
    await setStageInTx(client, executionId, 'completed');
    await finalise(client, tenantId, executionId, { verdict: 'answered', answer: candidate.answer, citations: candidate.claims,
      reviewerDecision: 'approve', failureReason: null });
    await store.release(fence, 'succeeded', 'completed');
    return { effect: 'finalised', reason: 'completed' };
  }
  if (decision === 'insufficient_evidence') {
    await setStageInTx(client, executionId, 'insufficient_evidence');
    await finalise(client, tenantId, executionId, { verdict: 'insufficient_evidence', answer: null, citations: [],
      reviewerDecision: 'insufficient_evidence', failureReason: null });
    await store.release(fence, 'succeeded', 'insufficient_evidence');
    return { effect: 'finalised', reason: 'insufficient_evidence' };
  }
  await setStageInTx(client, executionId, 'failed');
  await finalise(client, tenantId, executionId, { verdict: 'failed', answer: null, citations: [], reviewerDecision: 'reject', failureReason: 'review_rejected' });
  await store.release(fence, 'failed', 'review_rejected');
  return { effect: 'finalised', reason: 'review_rejected' };
}

async function finalise(client: TenantQueryable, tenantId: string, executionId: string, result: {
  verdict: 'answered' | 'insufficient_evidence' | 'failed'; answer: string | null; citations: unknown[];
  reviewerDecision: 'approve' | 'insufficient_evidence' | 'reject' | 'not_reviewed'; failureReason: string | null;
}): Promise<void> {
  await client.query(
    `INSERT INTO aegis.investigation_results (execution_id, tenant_id, verdict, answer, citations, reviewer_decision, failure_reason)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7)`,
    [executionId, tenantId, result.verdict, result.answer, JSON.stringify(result.citations), result.reviewerDecision, result.failureReason]);
}

export { recordMessageEvent, WORKFLOW_SCOPES };
export { ROOT_AGENT };

/** Marks an execution failed in the caller's transaction. Used when a step cannot be authorised or a result is invalid. */
export async function failExecutionInTx(client: TenantQueryable, hooks: ExecutionHooks, tenantId: string, fence: Fence, reason: string,
  fromStage: string): Promise<void> {
  const store = createAgentExecutionStore(joinTransaction(client, tenantId), hooks);
  if (fromStage !== 'failed') await setStageInTx(client, fence.executionId, 'failed');
  await finalise(client, tenantId, fence.executionId, { verdict: 'failed', answer: null, citations: [], reviewerDecision: 'not_reviewed', failureReason: reason });
  await store.release(fence, 'failed', reason);
}

/**
 * Intake: starts a submitted investigation. The orchestrator takes the lease (P4 claim), reads the question recorded by the gateway, and
 * dispatches the triage request, all in one transaction. A cancellation requested before intake is applied by the claim itself.
 */
export async function startInvestigationInTx(client: TenantQueryable, hooks: ExecutionHooks, input: {
  tenantId: string; executionId: string; orchestrator: { spiffeId: string; instance: string };
}): Promise<'started' | 'cancelled' | 'skipped' | 'failed'> {
  const store = createAgentExecutionStore(joinTransaction(client, input.tenantId), hooks);
  const claim = await store.claim({ tenantId: input.tenantId, executionId: input.executionId, spiffeId: input.orchestrator.spiffeId,
    instance: input.orchestrator.instance, leaseSeconds: 60 });
  if (!claim.ok) return claim.reason === 'cancel_requested' ? 'cancelled' : 'skipped';
  const fence: Fence = { tenantId: input.tenantId, executionId: input.executionId, agentId: claim.value.agentId, instance: input.orchestrator.instance,
    fencingToken: claim.value.fencingToken };
  const question = (await client.query<{ question: string }>('SELECT question FROM aegis.investigation_requests WHERE execution_id = $1',
    [input.executionId])).rows[0]?.question;
  if (!question) { await failExecutionInTx(client, hooks, input.tenantId, fence, 'missing_request', 'submitted'); return 'failed'; }
  const step = await dispatchStepInTx(client, hooks, { tenantId: input.tenantId, fence, to: TRIAGE_AGENT, requestedScopes: [...WORKFLOW_SCOPES],
    action: ACTIONS.plan, resultAction: ACTIONS.planResult, arguments: { question }, nextStage: 'triage_requested' });
  if (!step.ok) {
    await failExecutionInTx(client, hooks, input.tenantId, fence, step.reason, 'submitted');
    return 'failed';
  }
  return 'started';
}

import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Pool, PoolClient } from 'pg';
import { createDefaultToolDispatcher } from '../agents/default-tools.js';
import { syntheticCases } from '../contracts/triage.js';
import { createPostgresApprovalStore, type TenantQueryable } from '../security/tool-approval-store.js';
import { AuthorizationError, requireScope, type VerifiedPrincipal, type VerifyToken } from '../auth/token.js';
import { withAuthenticatedTransaction } from '../auth/transaction.js';
import { createDurableStore } from './durable-store.js';
import { runTriageWorkflow } from './triage-workflow.js';
import { parseTraceparent } from './trace-context.js';

const uuid = { type: 'string', pattern: '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$' };

const policy = { maxAttempts: 3, baseDelayMs: 1000, maxDelayMs: 8000 } as const;
const LEASE_MS = 30_000;
const TIMEOUT_MS = 5_000;
const DEFAULT_DEAD_LETTER_LIMIT = 20;

/** A caller-supplied correlation id is echoed and logged only if it is short and printable. Anything else is replaced. */
const CORRELATION_ID = /^[A-Za-z0-9._:-]{1,128}$/;

/** Runs one operation in its own transaction with the tenant set for row-level security. */
function tenantRunner(pool: Pool) {
  return async <T>(tenantId: string, operation: (client: TenantQueryable) => Promise<T>): Promise<T> => {
    const client: PoolClient = await pool.connect();
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
}

interface TriageBody { caseId: (typeof syntheticCases)[number]['id'] }
interface TenantParams { tenantId: string }
interface ExecutionParams extends TenantParams { executionId: string }
interface DeadLetterQuery { limit?: number }
interface RequeueBody { reason: string }

/**
 * Workflow routes. Every route requires a bearer token, the read:cases scope and tenant membership.
 * - POST /api/tenants/:tenantId/workflows/triage            run the triage tool once per Idempotency-Key
 * - GET  /api/tenants/:tenantId/workflows/executions/:id    execution state and checkpoints
 * - GET  /api/tenants/:tenantId/workflows/dead-letters      failed executions, newest first (read-only)
 * - POST /api/tenants/:tenantId/workflows/dead-letters/:id/requeue   operators only: one more attempt, with a reason, audited
 * Each response carries x-correlation-id: the caller's valid id, or the request id.
 */
export async function registerProtectedWorkflowRoutes(app: FastifyInstance, pool: Pool, verify: VerifyToken): Promise<void> {
  const principals = new WeakMap<FastifyRequest, VerifiedPrincipal>();
  const correlations = new WeakMap<FastifyRequest, string>();
  const runTenant = tenantRunner(pool);
  const store = createDurableStore(runTenant);
  const dispatcher = createDefaultToolDispatcher(createPostgresApprovalStore(runTenant));

  /** Authenticates, checks the scope and checks membership for the tenant in the path. Throws AuthorizationError otherwise. */
  async function authorise(request: FastifyRequest, tenantId: string, permission: 'read:cases' | 'write:cases' = 'read:cases'): Promise<VerifiedPrincipal> {
    const principal = principals.get(request);
    if (!principal) throw new AuthorizationError(401);
    requireScope(principal, permission);
    // write:cases also requires the operator role; the transaction helper enforces that.
    await withAuthenticatedTransaction(pool, principal, tenantId, permission, async () => undefined);
    return principal;
  }

  app.addHook('onRequest', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const supplied = request.headers['x-correlation-id'];
    const correlationId = typeof supplied === 'string' && CORRELATION_ID.test(supplied) ? supplied : request.id;
    correlations.set(request, correlationId);
    reply.header('x-correlation-id', correlationId);
    principals.set(request, await verify(request.headers.authorization));
  });

  app.setErrorHandler((error, request, reply) => {
    const status = error instanceof AuthorizationError ? error.status
      : typeof error === 'object' && error !== null && 'statusCode' in error && (error as { statusCode?: number }).statusCode === 400 ? 400
      : 503;
    console.error(JSON.stringify({ event: 'workflow_request', requestId: request.id, correlationId: correlations.get(request), outcome: 'failure', status }));
    if (status === 401) reply.header('WWW-Authenticate', 'Bearer');
    const message = status === 401 ? 'Authentication required.' : status === 403 ? 'Access denied.'
      : status === 400 ? 'Invalid workflow request.' : 'Workflow storage is unavailable. Please retry.';
    return reply.code(status).send({ error: message });
  });

  app.post<{ Params: TenantParams; Body: TriageBody }>('/api/tenants/:tenantId/workflows/triage', {
    schema: {
      params: { type: 'object', required: ['tenantId'], additionalProperties: false, properties: { tenantId: uuid } },
      headers: { type: 'object', required: ['idempotency-key'], properties: { 'idempotency-key': uuid } },
      body: {
        type: 'object', required: ['caseId'], additionalProperties: false,
        properties: { caseId: { type: 'string', enum: syntheticCases.map((c) => c.id) } },
      },
    },
  }, async (request, reply) => {
    const tenantId = request.params.tenantId;
    const principal = await authorise(request, tenantId);

    const idempotencyKey = String(request.headers['idempotency-key']).toLowerCase();
    const result = await runTriageWorkflow({
      store, dispatcher, tenantId, idempotencyKey,
      args: { caseId: request.body.caseId },
      context: {
        tenantId, userId: principal.subject, userScopes: ['cases:read'], agentId: 'triage-agent', requestedBy: principal.subject,
      },
      owner: `api-${request.id}`,
      correlationId: correlations.get(request),
      traceId: parseTraceparent(request.headers.traceparent as string | undefined),
      log: (record) => console.info(JSON.stringify({ ...record, requestId: request.id })),
      policy, leaseMs: LEASE_MS, timeoutMs: TIMEOUT_MS, clock: () => new Date(),
    });

    console.info(JSON.stringify({
      event: 'workflow_request', requestId: request.id, correlationId: correlations.get(request), outcome: 'success',
      executionId: result.executionId, created: result.created, driverStatus: result.driver.status,
    }));
    return reply.code(result.created ? 201 : 200).send({
      executionId: result.executionId,
      created: result.created,
      outcome: result.driver.status,
      ...(result.output !== undefined ? { output: result.output } : {}),
    });
  });

  app.get<{ Params: ExecutionParams }>('/api/tenants/:tenantId/workflows/executions/:executionId', {
    schema: {
      params: {
        type: 'object', required: ['tenantId', 'executionId'], additionalProperties: false,
        properties: { tenantId: uuid, executionId: uuid },
      },
    },
  }, async (request, reply) => {
    const { tenantId, executionId } = request.params;
    await authorise(request, tenantId);
    const found = await store.load(executionId, tenantId);
    if (!found) {
      console.info(JSON.stringify({ event: 'workflow_request', route: 'execution_status', requestId: request.id, correlationId: correlations.get(request), outcome: 'not_found' }));
      return reply.code(404).send({ error: 'Execution not found.' });
    }
    const { execution, checkpoints } = found;
    console.info(JSON.stringify({ event: 'workflow_request', route: 'execution_status', requestId: request.id, correlationId: correlations.get(request), outcome: 'success', executionId, state: execution.state }));
    return reply.send({
      executionId: execution.executionId,
      state: execution.state,
      attempts: execution.attempts,
      maxAttempts: execution.maxAttempts,
      version: execution.version,
      lastErrorClass: execution.lastErrorClass,
      correlationId: execution.correlationId,
      cancelRequested: execution.cancelRequested,
      approvalGranted: execution.approvalGranted,
      checkpoints,
    });
  });

  app.get<{ Params: TenantParams; Querystring: DeadLetterQuery }>('/api/tenants/:tenantId/workflows/dead-letters', {
    schema: {
      params: { type: 'object', required: ['tenantId'], additionalProperties: false, properties: { tenantId: uuid } },
      querystring: {
        type: 'object', additionalProperties: false,
        properties: { limit: { type: 'integer', minimum: 1, maximum: 100 } },
      },
    },
  }, async (request, reply) => {
    const tenantId = request.params.tenantId;
    await authorise(request, tenantId);
    const rows = await store.listDeadLetters(tenantId, request.query.limit ?? DEFAULT_DEAD_LETTER_LIMIT);
    console.info(JSON.stringify({ event: 'workflow_request', route: 'dead_letters', requestId: request.id, correlationId: correlations.get(request), outcome: 'success', count: rows.length }));
    return reply.send({
      items: rows.map((row) => ({
        executionId: row.executionId,
        attempts: row.attempts,
        maxAttempts: row.maxAttempts,
        lastErrorClass: row.lastErrorClass,
        updatedAt: row.updatedAt.toISOString(),
      })),
    });
  });

  app.post<{ Params: ExecutionParams; Body: RequeueBody }>('/api/tenants/:tenantId/workflows/dead-letters/:executionId/requeue', {
    schema: {
      params: {
        type: 'object', required: ['tenantId', 'executionId'], additionalProperties: false,
        properties: { tenantId: uuid, executionId: uuid },
      },
      body: {
        type: 'object', required: ['reason'], additionalProperties: false,
        properties: { reason: { type: 'string', minLength: 1, maxLength: 500, pattern: '\\S' } },
      },
    },
  }, async (request, reply) => {
    const { tenantId, executionId } = request.params;
    const principal = await authorise(request, tenantId, 'write:cases');
    const outcome = await store.requeue(executionId, tenantId, principal.subject, request.body.reason, new Date());
    console.info(JSON.stringify({
      event: 'workflow_request', route: 'dead_letter_requeue', requestId: request.id, correlationId: correlations.get(request),
      outcome: outcome.outcome, executionId,
    }));
    if (outcome.outcome === 'not_found') return reply.code(404).send({ error: 'Execution not found.' });
    if (outcome.outcome === 'not_failed') {
      return reply.code(409).send({ error: 'Only a failed execution without a cancellation request can be requeued.' });
    }
    return reply.send({ executionId, state: 'retry_wait', version: outcome.version, attempts: outcome.attempts });
  });
}

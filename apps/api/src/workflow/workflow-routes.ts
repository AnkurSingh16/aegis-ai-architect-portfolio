import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Pool, PoolClient } from 'pg';
import { createDefaultToolDispatcher } from '../agents/default-tools.js';
import { syntheticCases } from '../contracts/triage.js';
import { createPostgresApprovalStore, type TenantQueryable } from '../security/tool-approval-store.js';
import { AuthorizationError, requireScope, type VerifiedPrincipal, type VerifyToken } from '../auth/token.js';
import { withAuthenticatedTransaction } from '../auth/transaction.js';
import { createDurableStore } from './durable-store.js';
import { runTriageWorkflow } from './triage-workflow.js';

const uuid = { type: 'string', pattern: '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$' };

const policy = { maxAttempts: 3, baseDelayMs: 1000, maxDelayMs: 8000 } as const;
const LEASE_MS = 30_000;
const TIMEOUT_MS = 5_000;

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

/**
 * POST /api/tenants/:tenantId/workflows/triage
 * Authenticated, membership-checked, idempotent (Idempotency-Key header). Runs the triage tool as a durable execution.
 */
export async function registerProtectedWorkflowRoutes(app: FastifyInstance, pool: Pool, verify: VerifyToken): Promise<void> {
  const principals = new WeakMap<FastifyRequest, VerifiedPrincipal>();
  const runTenant = tenantRunner(pool);
  const store = createDurableStore(runTenant);
  const dispatcher = createDefaultToolDispatcher(createPostgresApprovalStore(runTenant));

  app.addHook('onRequest', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    principals.set(request, await verify(request.headers.authorization));
  });

  app.setErrorHandler((error, request, reply) => {
    const status = error instanceof AuthorizationError ? error.status
      : typeof error === 'object' && error !== null && 'statusCode' in error && (error as { statusCode?: number }).statusCode === 400 ? 400
      : 503;
    console.error(JSON.stringify({ event: 'workflow_request', requestId: request.id, outcome: 'failure', status }));
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
    const principal = principals.get(request);
    if (!principal) throw new AuthorizationError(401);
    const tenantId = request.params.tenantId;
    requireScope(principal, 'read:cases');
    // Membership check in its own transaction. Only then is the tenant context used for the workflow.
    await withAuthenticatedTransaction(pool, principal, tenantId, 'read:cases', async () => undefined);

    const idempotencyKey = String(request.headers['idempotency-key']).toLowerCase();
    const result = await runTriageWorkflow({
      store, dispatcher, tenantId, idempotencyKey,
      args: { caseId: request.body.caseId },
      context: {
        tenantId, userId: principal.subject, userScopes: ['cases:read'], agentId: 'triage-agent', requestedBy: principal.subject,
      },
      owner: `api-${request.id}`,
      policy, leaseMs: LEASE_MS, timeoutMs: TIMEOUT_MS, clock: () => new Date(),
    });

    console.info(JSON.stringify({ event: 'workflow_request', requestId: request.id, outcome: 'success', created: result.created }));
    return reply.code(result.created ? 201 : 200).send({
      executionId: result.executionId,
      created: result.created,
      outcome: result.driver.status,
      ...(result.output !== undefined ? { output: result.output } : {}),
    });
  });
}

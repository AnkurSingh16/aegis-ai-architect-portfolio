import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import { syntheticCases } from '../contracts/triage.js';
import { CaseStorageError, caseStatuses } from '../storage/models.js';
import { createCase, listCases, readCase, updateCase } from '../storage/queries.js';
import { AuthorizationError, type Permission, type VerifiedPrincipal, type VerifyToken } from './token.js';
import { withAuthenticatedTransaction } from './transaction.js';
import { AnalysisDisabledError, AnalysisUnavailableError, type AnalysisProvider } from '../ai/provider.js';

const uuid = { type: 'string', pattern: '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$' };
const tenantParams = { type: 'object', required: ['tenantId'], additionalProperties: false, properties: { tenantId: uuid } };
const caseParams = { type: 'object', required: ['tenantId', 'caseId'], additionalProperties: false,
  properties: { tenantId: uuid, caseId: uuid } };
type TenantParams = { tenantId: string };
type CaseParams = TenantParams & { caseId: string };

export async function registerProtectedCaseRoutes(app: FastifyInstance, pool: Pool, verify: VerifyToken,
  analysisProvider?: AnalysisProvider): Promise<void> {
  const principals = new WeakMap<FastifyRequest, VerifiedPrincipal>();
  app.addHook('onRequest', async (request) => {
    principals.set(request, await verify(request.headers.authorization));
  });
  app.setErrorHandler((error, request, reply) => {
    const candidateStatus = typeof error === 'object' && error !== null && 'statusCode' in error
      ? error.statusCode : undefined;
    const status = error instanceof AuthorizationError ? error.status
      : error instanceof AnalysisUnavailableError || error instanceof AnalysisDisabledError ? 503
      : error instanceof CaseStorageError ? (error.code === 'not_found' ? 404 : error.code === 'invalid_input' ? 400 : 503)
        : candidateStatus === 400 || candidateStatus === 413 || candidateStatus === 415 ? candidateStatus : 503;
    console.error(JSON.stringify({ event: 'protected_case_request', requestId: request.id,
      outcome: 'failure', code: status === 401 ? 'unauthenticated' : status === 403 ? 'forbidden'
        : status === 404 ? 'not_found' : status < 500 ? 'invalid_input' : 'unavailable' }));
    if (status === 401) reply.header('WWW-Authenticate', 'Bearer');
    const message = status === 401 ? 'Authentication required.' : status === 403 ? 'Access denied.'
      : status === 404 ? 'Case not found.' : error instanceof AnalysisDisabledError ? 'AI analysis is disabled for this development server.'
        : error instanceof AnalysisUnavailableError ? 'AI analysis is unavailable. Check the local development provider and retry.'
        : status < 500 ? 'Invalid case request.' : 'Case storage is unavailable. Please retry.';
    if (error instanceof AnalysisDisabledError) return reply.code(status).send({ error: message, code: 'ai_analysis_disabled' });
    if (error instanceof AnalysisUnavailableError) return reply.code(status).send({ error: message, code: 'ai_analysis_unavailable' });
    return reply.code(status).send({ error: message });
  });
  async function run<T>(request: FastifyRequest, tenantId: string, permission: Permission,
    operation: Parameters<typeof withAuthenticatedTransaction<T>>[4]): Promise<T> {
    const principal = principals.get(request);
    if (!principal) throw new AuthorizationError(401);
    const result = await withAuthenticatedTransaction(pool, principal, tenantId, permission, operation);
    console.info(JSON.stringify({ event: 'protected_case_request', requestId: request.id, outcome: 'success' }));
    return result;
  }
  app.get<{ Params: TenantParams }>('/api/tenants/:tenantId/cases', {
    schema: { params: tenantParams, querystring: { type: 'object', additionalProperties: false } },
  }, (request) => run(request, request.params.tenantId, 'read:cases', listCases));
  app.get<{ Params: CaseParams }>('/api/tenants/:tenantId/cases/:caseId', {
    schema: { params: caseParams, querystring: { type: 'object', additionalProperties: false } },
  }, (request) => run(request, request.params.tenantId, 'read:cases', (client) => readCase(client, request.params.caseId)));
  app.post<{ Params: TenantParams; Body: { syntheticCaseId: string } }>('/api/tenants/:tenantId/cases', {
    bodyLimit: 1024, schema: { params: tenantParams, querystring: { type: 'object', additionalProperties: false },
      body: { type: 'object', required: ['syntheticCaseId'], additionalProperties: false,
        properties: { syntheticCaseId: { type: 'string', enum: syntheticCases.map((item) => item.id) } } } },
  }, async (request, reply) => {
    const result = await run(request, request.params.tenantId, 'write:cases',
      (client) => createCase(client, request.params.tenantId, request.body.syntheticCaseId));
    return reply.code(201).send(result);
  });
  app.patch<{ Params: CaseParams; Body: { status: string } }>('/api/tenants/:tenantId/cases/:caseId/status', {
    bodyLimit: 1024, schema: { params: caseParams, querystring: { type: 'object', additionalProperties: false },
      body: { type: 'object', required: ['status'], additionalProperties: false,
        properties: { status: { type: 'string', enum: caseStatuses } } } },
  }, (request) => run(request, request.params.tenantId, 'write:cases',
    (client) => updateCase(client, request.params.caseId, request.body.status)));

  if (process.env.NODE_ENV !== 'production') {
    app.post<{ Params: CaseParams; Body?: unknown }>('/api/tenants/:tenantId/cases/:caseId/ai-analysis', {
      bodyLimit: 512,
      schema: { params: caseParams, querystring: { type: 'object', additionalProperties: false } },
    }, async (request, reply) => {
      if (request.body !== undefined && (typeof request.body !== 'object' || request.body === null ||
          Array.isArray(request.body) || Object.keys(request.body).length !== 0)) {
        throw new CaseStorageError('invalid_input');
      }
      // Authorization, membership and RLS complete before model inference begins.
      const stored = await run(request, request.params.tenantId, 'read:cases',
        (client) => readCase(client, request.params.caseId));
      if (!analysisProvider) throw new AnalysisDisabledError();

      const controller = new AbortController();
      const cancelIfDisconnected = () => { if (!reply.raw.writableEnded) controller.abort(); };
      request.raw.once('aborted', cancelIfDisconnected);
      reply.raw.once('close', cancelIfDisconnected);
      try {
        const result = await analysisProvider.analyze(stored, controller.signal);
        if (controller.signal.aborted) return;
        return result;
      } catch (error) {
        if (controller.signal.aborted) return;
        throw error instanceof AnalysisDisabledError || error instanceof AnalysisUnavailableError ? error : new AnalysisUnavailableError();
      } finally {
        request.raw.removeListener('aborted', cancelIfDisconnected);
        reply.raw.removeListener('close', cancelIfDisconnected);
      }
    });
  }
}

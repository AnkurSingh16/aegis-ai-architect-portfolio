import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import { AuthorizationError, type VerifiedPrincipal, type VerifyToken } from './token.js';
import { GatewayError, readInvestigation, requestCancellation, submitInvestigation, type Principal } from '../investigation/gateway.js';
import { withMessagingContext } from '../orchestration/messaging/context.js';

/**
 * Authenticated investigation API. Every route verifies the bearer token, then calls the investigation gateway, which checks tenant
 * membership and the principal's scopes in the database. The request supplies only the tenant, the idempotency key, the question and a
 * cancellation reason. It never supplies a principal, a scope, an agent or an execution owner.
 */

const uuid = { type: 'string', pattern: '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' };

export function registerInvestigationRoutes(app: FastifyInstance, gateway: Pool, verify: VerifyToken): void {
  app.register(async (investigationApp) => {
    const principals = new WeakMap<FastifyRequest, VerifiedPrincipal>();
    investigationApp.addHook('onRequest', async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      principals.set(request, await verify(request.headers.authorization));
    });
    investigationApp.setErrorHandler((error, request, reply) => {
      const status = error instanceof AuthorizationError ? error.status
        : error instanceof GatewayError ? ({ forbidden: 403, invalid_request: 400, idempotency_conflict: 409, not_found: 404 } as Record<string, number>)[error.code] ?? 503
          : typeof error === 'object' && error !== null && 'statusCode' in error && (error as { statusCode: number }).statusCode === 400 ? 400 : 503;
      if (status === 401) reply.header('WWW-Authenticate', 'Bearer');
      const code = error instanceof GatewayError ? error.code : status === 401 ? 'unauthenticated' : status === 403 ? 'forbidden' : status < 500 ? 'invalid_request' : 'unavailable';
      console.info(JSON.stringify({ event: 'investigation_request', requestId: request.id, outcome: 'failure', code }));
      return reply.code(status).send({ error: code });
    });

    const principalOf = (request: FastifyRequest): Principal => {
      const verified = principals.get(request);
      if (!verified) throw new AuthorizationError(401);
      return { issuer: verified.issuer, subject: verified.subject, scopes: verified.scopes };
    };
    const run = (tenantId: string, operation: Parameters<typeof withMessagingContext>[2]) => withMessagingContext(gateway, { tenantId }, operation);

    investigationApp.post<{ Params: { tenantId: string }; Body: { question: string }; Headers: { 'idempotency-key': string } }>(
      '/api/tenants/:tenantId/investigations', {
        bodyLimit: 4096,
        schema: {
          params: { type: 'object', required: ['tenantId'], additionalProperties: false, properties: { tenantId: uuid } },
          headers: { type: 'object', required: ['idempotency-key'], properties: { 'idempotency-key': uuid } },
          body: { type: 'object', required: ['question'], additionalProperties: false, properties: { question: { type: 'string', minLength: 1, maxLength: 1000 } } },
        },
      }, async (request, reply) => {
        const result = await submitInvestigation(run as never, principalOf(request), {
          tenantId: request.params.tenantId, idempotencyKey: request.headers['idempotency-key'], question: request.body.question });
        const location = `/api/tenants/${request.params.tenantId}/investigations/${result.executionId}`;
        return reply.code(result.created ? 202 : 200).header('Location', location)
          .send({ executionId: result.executionId, created: result.created, statusUrl: location });
      });

    investigationApp.get<{ Params: { tenantId: string; executionId: string } }>('/api/tenants/:tenantId/investigations/:executionId', {
      schema: { params: { type: 'object', required: ['tenantId', 'executionId'], additionalProperties: false,
        properties: { tenantId: uuid, executionId: uuid } } },
    }, async (request) => readInvestigation(run as never, principalOf(request),
      { tenantId: request.params.tenantId, executionId: request.params.executionId }));

    investigationApp.post<{ Params: { tenantId: string; executionId: string }; Body: { reason: string } }>(
      '/api/tenants/:tenantId/investigations/:executionId/cancel', {
        bodyLimit: 512,
        schema: {
          params: { type: 'object', required: ['tenantId', 'executionId'], additionalProperties: false, properties: { tenantId: uuid, executionId: uuid } },
          body: { type: 'object', required: ['reason'], additionalProperties: false, properties: { reason: { type: 'string', pattern: '^[a-z_]{1,40}$' } } },
        },
      }, async (request) => requestCancellation(run as never, principalOf(request),
        { tenantId: request.params.tenantId, executionId: request.params.executionId, reason: request.body.reason }));
  });
}

export type { FastifyRequest };

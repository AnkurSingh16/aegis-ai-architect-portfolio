import type { FastifyInstance } from 'fastify';
import { AuthorizationError, requireScope, type VerifiedPrincipal, type VerifyToken } from '../auth/token.js';
import { renderPrometheus, type WorkflowMetrics } from '../workflow/workflow-metrics.js';

/**
 * Process metrics endpoint. Disabled by default: it is registered only when AEGIS_METRICS_ENDPOINT is exactly "enabled".
 * It needs a bearer token that carries the dedicated observe:metrics permission. Read and write permissions do not grant it.
 * The metrics are process-wide counts, so they are not tenant-scoped; the permission is the boundary.
 * It returns only the fixed metric names and outcome labels. No tenant, case or execution identifier is exposed.
 */
export const METRICS_ENDPOINT_ENV = 'AEGIS_METRICS_ENDPOINT' as const;
export const METRICS_PATH = '/api/operations/workflow-metrics' as const;

export function metricsEndpointEnabled(env: NodeJS.ProcessEnv): boolean {
  return env[METRICS_ENDPOINT_ENV] === 'enabled';
}

export async function registerMetricsRoute(app: FastifyInstance, verify: VerifyToken, metrics: WorkflowMetrics): Promise<void> {
  app.get(METRICS_PATH, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    let principal: VerifiedPrincipal;
    try {
      principal = await verify(request.headers.authorization);
      requireScope(principal, 'observe:metrics');
    } catch (error) {
      if (error instanceof AuthorizationError) {
        if (error.status === 401) reply.header('WWW-Authenticate', 'Bearer');
        return reply.code(error.status).send({ error: error.status === 401 ? 'Authentication required.' : 'Access denied.' });
      }
      return reply.code(503).send({ error: 'The request could not be completed. Please retry.' });
    }
    reply.header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
    return reply.code(200).send(renderPrometheus(metrics.snapshot()));
  });
}

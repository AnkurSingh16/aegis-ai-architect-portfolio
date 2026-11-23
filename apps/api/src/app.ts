import { logEvent } from './observability/log.js';
import { assertSingleTracingExporter } from './observability/otel.js';
import { trace } from '@opentelemetry/api';
import Fastify from 'fastify';
import { randomUUID } from 'node:crypto';
import { answerDemoQuestion } from './demo.js';
import { triageRequestSchema, triageResponseSchema, type TriageRequest } from './contracts/triage.js';
import { triageCase } from './triage.js';
import type { JWTVerifyGetKey } from 'jose';
import type { Pool } from 'pg';
import { resolveAuthConfig, type AuthConfig } from './auth/config.js';
import { createTokenVerifier } from './auth/token.js';
import { registerProtectedCaseRoutes } from './auth/routes.js';
import { registerInvestigationRoutes } from './auth/investigation-routes.js';
import { registerProtectedWorkflowRoutes } from './workflow/workflow-routes.js';
import { registerProtectedAnswerRoutes } from './rag/answer-routes.js';
import { createDatabasePool, verifyRuntimeRole } from './storage/database.js';
import { createOllamaProvider, resolveOllamaConfig, type AnalysisProvider } from './ai/provider.js';
import { createGroundedOllamaProvider } from './ai/grounded-provider.js';
import type { GroundedAnalysisProvider } from './ai/grounded-analysis.js';
import { createWorkflowMetrics } from './workflow/workflow-metrics.js';
import { metricsEndpointEnabled, registerMetricsRoute } from './observability/metrics-endpoint.js';
import { tracingFromEnv } from './observability/tracing.js';
import { checkReadiness } from './readiness.js';

export interface AppOptions {
  authConfig?: AuthConfig;
  testDependencies?: { keyResolver?: JWTVerifyGetKey; pool?: Pool; gatewayPool?: Pool; analysisProvider?: AnalysisProvider; groundedAnalysisProvider?: GroundedAnalysisProvider };
}

export function createApp(options: AppOptions = {}) {
  assertSingleTracingExporter(process.env);
  if (options.testDependencies && process.env.NODE_ENV !== 'test') throw new Error('Test dependencies are unavailable.');
  const authConfig = options.authConfig ? resolveAuthConfig({ OIDC_ISSUER: options.authConfig.issuer,
    OIDC_AUDIENCE: options.authConfig.audience, DATABASE_URL: options.authConfig.databaseUrl,
    ...(options.authConfig.jwksUri === undefined ? {} : { OIDC_JWKS_URI: options.authConfig.jwksUri }),
    AEGIS_ENVIRONMENT: process.env.AEGIS_ENVIRONMENT, AEGIS_ALLOWED_SERVICE_HOSTS: process.env.AEGIS_ALLOWED_SERVICE_HOSTS })
    : resolveAuthConfig(process.env);
  const aiConfig = resolveOllamaConfig(process.env);
  if (aiConfig && !authConfig) throw new Error('AI analysis requires the authenticated case API.');
  const analysisProvider = options.testDependencies?.analysisProvider ?? (aiConfig ? createOllamaProvider(aiConfig) : undefined);
  const groundedEnabled = process.env.NODE_ENV === 'development' && process.env.AEGIS_AI_ENABLED === 'true' &&
    process.env.AEGIS_GROUNDED_AI_ENABLED === 'true';
  const groundedAnalysisProvider = options.testDependencies?.groundedAnalysisProvider ??
    (groundedEnabled && aiConfig ? createGroundedOllamaProvider(aiConfig) : undefined);
  const app = Fastify({ logger: false, requestIdHeader: false, genReqId: () => randomUUID(),
    ajv: { customOptions: { removeAdditional: false, coerceTypes: false } } });
  // The route template (for example /api/tenants/:tenantId/cases) is named on the active request span, so traces group by operation
  // and never by identifier. Fastify knows the template; the raw URL is not exported.
  // One completion record per request: route template, status and outcome only. It is the log that correlates a browser-driven
  // request with its trace. Successful requests are logged here, because the error handler only logs failures.
  app.addHook('onResponse', async (request, reply) => {
    const template = request.routeOptions?.url ?? 'unmatched';
    logEvent('http_request_completed', {
      'http.route': template,
      'http.response.status_code': reply.statusCode,
      outcome: reply.statusCode < 400 ? 'success' : reply.statusCode < 500 ? 'client_error' : 'server_error',
    });
  });
  app.addHook('preHandler', async (request) => {
    const template = request.routeOptions?.url;
    const span = trace.getActiveSpan();
    if (span && template) {
      span.setAttribute('http.route', template);
      span.updateName(`${request.method} ${template}`);
    }
  });
  app.get('/api/health', async () => ({ ok: true, service: 'aegis-api', mode: 'starter' }));
  if (!authConfig) {
    // Without a database configuration this instance cannot serve case data, so it must not report ready.
    app.get('/api/ready', async (_request, reply) => reply.code(503).send({ ready: false, reason: 'database_not_configured' }));
  }

  if (authConfig) {
    const verify = createTokenVerifier(authConfig, options.testDependencies?.keyResolver);
    const pool = options.testDependencies?.pool ?? createDatabasePool(authConfig.databaseUrl);
    let closed = false;
    async function closeDatabase() {
      if (!closed) { closed = true; await pool.end(); }
    }
    app.addHook('onReady', async () => {
      try { await verifyRuntimeRole(pool); }
      catch { await closeDatabase(); throw new Error('Protected case storage initialization failed.'); }
    });
    app.addHook('onClose', closeDatabase);
    app.get('/api/ready', async (_request, reply) => {
      const result = await checkReadiness(pool);
      return reply.code(result.ready ? 200 : 503).send(result);
    });
    app.register(async (protectedApp) => registerProtectedCaseRoutes(protectedApp, pool, verify, analysisProvider, groundedAnalysisProvider));
    // One collector per process: the triage route records into it, and the metrics endpoint (off by default) reads it.
    const processMetrics = createWorkflowMetrics();
    app.register(async (workflowApp) => registerProtectedWorkflowRoutes(workflowApp, pool, verify, { metrics: processMetrics, spanSink }));
    if (metricsEndpointEnabled(process.env)) {
      app.register(async (metricsApp) => registerMetricsRoute(metricsApp, verify, processMetrics));
    }
    const spanSink = tracingFromEnv(process.env);
    app.register(async (answerApp) => registerProtectedAnswerRoutes(answerApp, pool, verify));
    // Investigations run under the gateway role (migration 018). Routes are registered only when that role is configured.
    const gatewayUrl = process.env.DATABASE_GATEWAY_URL;
    if (gatewayUrl) {
      const gatewayPool = options.testDependencies?.gatewayPool ?? createDatabasePool(gatewayUrl, 4);
      app.addHook('onClose', async () => { await gatewayPool.end(); });
      registerInvestigationRoutes(app, gatewayPool, verify);
    }
  }

  // Do NOT enable unauthenticated demo routes in production.
  if (process.env.NODE_ENV !== 'production') {
    app.post<{ Body: TriageRequest }>('/api/demo/triage', {
      bodyLimit: 1024,
      schema: { body: triageRequestSchema, response: { 200: triageResponseSchema } },
      errorHandler(error, _request, reply) {
        const status = error.statusCode;
        if (status === 413) return reply.code(413).send({ error: 'Request is too large.' });
        if (status === 415) return reply.code(415).send({ error: 'Use an application/json request.' });
        if (status === 400) return reply.code(400).send({ error: 'Choose one supported synthetic case.' });
        return reply.code(500).send({ error: 'Triage is unavailable. Please retry.' });
      },
    }, async (request) => triageCase(request.body.caseId));
    app.post<{ Body: { question: string } }>(
      '/api/demo/query',
      {
        schema: {
          body: {
            type: 'object',
            required: ['question'],
            additionalProperties: false,
            properties: { question: { type: 'string', minLength: 1, maxLength: 500 } },
          },
        },
      },
      async (request) => answerDemoQuestion(request.body.question),
    );
  }
  return app;
}

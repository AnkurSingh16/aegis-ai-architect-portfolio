import Fastify from 'fastify';
import { answerDemoQuestion } from './demo.js';
import { triageRequestSchema, triageResponseSchema, type TriageRequest } from './contracts/triage.js';
import { triageCase } from './triage.js';
import type { JWTVerifyGetKey } from 'jose';
import type { Pool } from 'pg';
import { resolveAuthConfig, type AuthConfig } from './auth/config.js';
import { createTokenVerifier } from './auth/token.js';
import { registerProtectedCaseRoutes } from './auth/routes.js';
import { createDatabasePool, verifyRuntimeRole } from './storage/database.js';

export interface AppOptions {
  authConfig?: AuthConfig;
  testDependencies?: { keyResolver?: JWTVerifyGetKey; pool?: Pool };
}

export function createApp(options: AppOptions = {}) {
  if (options.testDependencies && process.env.NODE_ENV !== 'test') throw new Error('Test dependencies are unavailable.');
  const authConfig = options.authConfig ? resolveAuthConfig({ AUTH0_ISSUER: options.authConfig.issuer,
    AUTH0_AUDIENCE: options.authConfig.audience, DATABASE_URL: options.authConfig.databaseUrl }) : resolveAuthConfig(process.env);
  const app = Fastify({ logger: false, ajv: { customOptions: { removeAdditional: false, coerceTypes: false } } });
  app.get('/api/health', async () => ({ ok: true, service: 'aegis-api', mode: 'starter' }));

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
    app.register(async (protectedApp) => registerProtectedCaseRoutes(protectedApp, pool, verify));
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

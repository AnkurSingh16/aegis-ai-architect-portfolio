import Fastify from 'fastify';
import { answerDemoQuestion } from './demo.js';
import { triageRequestSchema, triageResponseSchema, type TriageRequest } from './contracts/triage.js';
import { triageCase } from './triage.js';

export function createApp() {
  const app = Fastify({ logger: false, ajv: { customOptions: { removeAdditional: false, coerceTypes: false } } });
  app.get('/api/health', async () => ({ ok: true, service: 'aegis-api', mode: 'starter' }));

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

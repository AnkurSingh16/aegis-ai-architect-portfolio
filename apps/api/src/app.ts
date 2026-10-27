import Fastify from 'fastify';
import { answerDemoQuestion } from './demo.js';

export function createApp() {
  const app = Fastify({ logger: false });
  app.get('/api/health', async () => ({ ok: true, service: 'aegis-api', mode: 'starter' }));

  // Do NOT enable unauthenticated demo routes in production.
  if (process.env.NODE_ENV !== 'production') {
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

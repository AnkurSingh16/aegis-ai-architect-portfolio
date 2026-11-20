import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import { AuthorizationError, requireScope, type VerifiedPrincipal, type VerifyToken } from '../auth/token.js';
import { withAuthenticatedTransaction } from '../auth/transaction.js';
import { EmbeddingError, embedTexts } from '../retrieval/ollama-embeddings.js';
import { vectorEvidenceRetriever, type QueryEmbedder } from './document-evidence.js';
import { createOllamaGenerator, GenerationError } from './ollama-generator.js';
import { answerWithSelfCorrection, type GenerateInput, type SelfCorrectionPolicy, type SelfCorrectionResult } from './self-correcting-answer.js';

/**
 * The answer policy. The floor is the owner's decision (docs/DEV-C4-FLOOR-V4.md): 0.70 is kept. The loop is bounded to two
 * rounds, does not retry on insufficient evidence (docs/DEV-C4-REFORMULATION.md: not accepted), and checks citations with
 * the output guard. No forbidden substrings are configured for production; the evaluations used a sentinel for testing.
 */
export const ANSWER_POLICY: SelfCorrectionPolicy = { maxRounds: 2, minScore: 0.7, forbiddenSubstrings: [] };

/** Injected for tests. In production both default to the local loopback Ollama services. */
export interface AnswerRouteDeps {
  readonly embedQuery?: QueryEmbedder;
  readonly generate?: (input: GenerateInput) => Promise<string>;
}

const uuid = { type: 'string', pattern: '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$' };
const CORRELATION_ID = /^[A-Za-z0-9._:-]{1,128}$/;

interface TenantParams { tenantId: string }
interface AnswerBody { question: string }

/**
 * Answer route. Every request needs a bearer token, the read:cases scope and membership of the tenant in the path.
 * - POST /api/tenants/:tenantId/answers   body { question }; returns either an answer with its citations, or an abstention
 * Retrieval is tenant-scoped vector search. Generation runs on the local loopback model. The log line records the outcome,
 * never the question or the answer text.
 */
export async function registerProtectedAnswerRoutes(app: FastifyInstance, pool: Pool, verify: VerifyToken, deps: AnswerRouteDeps = {}): Promise<void> {
  const principals = new WeakMap<FastifyRequest, VerifiedPrincipal>();
  const correlations = new WeakMap<FastifyRequest, string>();
  const embedQuery: QueryEmbedder = deps.embedQuery ?? (async (query) => (await embedTexts([query], 'search_query'))[0]!);
  const generate = deps.generate ?? createOllamaGenerator(undefined, 'v4');

  /** Checks the scope and membership for the tenant in the path. Throws AuthorizationError otherwise. */
  async function authorise(request: FastifyRequest, tenantId: string): Promise<VerifiedPrincipal> {
    const principal = principals.get(request);
    if (!principal) throw new AuthorizationError(401);
    requireScope(principal, 'read:cases');
    await withAuthenticatedTransaction(pool, principal, tenantId, 'read:cases', async () => undefined);
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
    console.error(JSON.stringify({ event: 'answer_request', requestId: request.id, correlationId: correlations.get(request), outcome: 'failure', status }));
    if (status === 401) reply.header('WWW-Authenticate', 'Bearer');
    const message = status === 401 ? 'Authentication required.' : status === 403 ? 'Access denied.'
      : status === 400 ? 'Invalid answer request.' : 'The request could not be completed. Please retry.';
    return reply.code(status).send({ error: message });
  });

  app.post<{ Params: TenantParams; Body: AnswerBody }>('/api/tenants/:tenantId/answers', {
    schema: {
      params: { type: 'object', required: ['tenantId'], additionalProperties: false, properties: { tenantId: uuid } },
      body: {
        type: 'object', required: ['question'], additionalProperties: false,
        properties: { question: { type: 'string', minLength: 1, maxLength: 1000, pattern: '\\S' } },
      },
    },
  }, async (request, reply) => {
    const tenantId = request.params.tenantId;
    const principal = await authorise(request, tenantId);
    const correlationId = correlations.get(request) ?? null;
    const retrieve = vectorEvidenceRetriever({
      run: (operation) => withAuthenticatedTransaction(pool, principal, tenantId, 'read:cases', operation),
      tenantId,
      embedQuery,
      topK: 5,
    });

    let result: SelfCorrectionResult;
    try {
      result = await answerWithSelfCorrection(request.body.question, { retrieve, generate, reformulate: async () => null }, ANSWER_POLICY);
    } catch (error) {
      if (error instanceof GenerationError || error instanceof EmbeddingError) {
        console.info(JSON.stringify({ event: 'answer_request', requestId: request.id, correlationId, outcome: 'unavailable' }));
        return reply.code(503).send({ error: 'Answer service is unavailable. Please retry.' });
      }
      throw error;
    }

    console.info(JSON.stringify({
      event: 'answer_request', requestId: request.id, correlationId, outcome: result.status, rounds: result.rounds,
      ...(result.status === 'abstained' ? { reason: result.reason } : {}),
    }));
    if (result.status === 'answered') {
      return reply.code(200).send({ status: 'answered', answer: result.answer, citations: result.citations, rounds: result.rounds });
    }
    return reply.code(200).send({ status: 'abstained', reason: result.reason, rounds: result.rounds });
  });
}

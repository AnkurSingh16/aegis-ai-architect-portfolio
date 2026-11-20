import type { PoolClient } from 'pg';
import { RetrievalError, retrieveDocumentChunks } from '../documents/retrieval.js';
import { retrieveByVector } from '../retrieval/vector-retrieval.js';
import type { TenantQueryable } from '../security/tool-approval-store.js';
import type { Evidence } from './self-correcting-answer.js';

/** Runs one operation on a client inside an authenticated, tenant-scoped transaction. Supplied by the caller. */
export type ClientRunner = <T>(operation: (client: PoolClient) => Promise<T>) => Promise<T>;

/**
 * Lexical retrieval for one tenant, mapped to the evidence shape the answer loop uses. Each call runs in its own
 * authenticated transaction through the runner. A query the retrieval layer rejects yields no evidence, so the
 * loop abstains instead of failing. Storage failures still propagate.
 */
export function lexicalEvidenceRetriever(run: ClientRunner, tenantId: string): (query: string) => Promise<Evidence[]> {
  return async (query) => {
    try {
      const chunks = await run((client) => retrieveDocumentChunks(client, tenantId, query));
      return chunks.map((chunk) => ({ sourceId: chunk.sourceIdentity, text: chunk.content, score: chunk.rank }));
    } catch (error) {
      if (error instanceof RetrievalError && error.code === 'invalid_query') return [];
      throw error;
    }
  };
}

/** Turns one query into an embedding. Injected so the adapter stays free of network code. */
export type QueryEmbedder = (query: string) => Promise<readonly number[]>;

/**
 * Vector retrieval for one tenant, mapped to the evidence shape the loop uses. The score is cosine similarity, so the
 * loop's score floor must be set for that scale, not for the lexical rank scale. An embedding failure propagates: the
 * loop does not answer from a query it could not embed.
 */
export function vectorEvidenceRetriever(options: { run: ClientRunner; tenantId: string; embedQuery: QueryEmbedder; topK?: number }): (query: string) => Promise<Evidence[]> {
  const topK = options.topK ?? 5;
  return async (query) => {
    const vector = await options.embedQuery(query);
    const hits = await options.run((client) => retrieveByVector(client as unknown as TenantQueryable, options.tenantId, vector, topK));
    return hits.map((hit) => ({ sourceId: hit.sourceIdentity, text: hit.content, score: hit.similarity }));
  };
}

import type { PoolClient } from 'pg';
import { RetrievalError, retrieveDocumentChunks } from '../documents/retrieval.js';
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

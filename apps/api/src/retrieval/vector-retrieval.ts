import type { TenantQueryable } from '../security/tool-approval-store.js';
import { EMBEDDING_MODEL, EMBEDDING_MODEL_DIGEST, toVectorLiteral } from './ollama-embeddings.js';

/** Stores embeddings for chunks of the same tenant. Row-level security enforces the tenant boundary. */
export async function storeChunkEmbeddings(client: TenantQueryable, tenantId: string,
  rows: readonly { chunkId: string; vector: readonly number[] }[]): Promise<number> {
  let stored = 0;
  for (const row of rows) {
    const result = await client.query(
      `INSERT INTO aegis.chunk_embeddings (chunk_id, tenant_id, model, model_digest, embedding)
       VALUES ($1, $2, $3, $4, $5::vector)
       ON CONFLICT (chunk_id, model) DO NOTHING`,
      [row.chunkId, tenantId, EMBEDDING_MODEL, EMBEDDING_MODEL_DIGEST, toVectorLiteral(row.vector)],
    );
    stored += result.rowCount ?? 0;
  }
  return stored;
}

export interface VectorHit { sourceIdentity: string; chunkId: string; similarity: number }

/** Nearest chunks by cosine distance for one tenant, ranked best first. Ties break on chunk id. */
export async function retrieveByVector(client: TenantQueryable, tenantId: string, queryVector: readonly number[], topK: number): Promise<VectorHit[]> {
  if (!Number.isInteger(topK) || topK < 1 || topK > 20) throw new RangeError('topK must be 1 to 20');
  const literal = toVectorLiteral(queryVector);
  const result = await client.query<{ source_identity: string; chunk_id: string; similarity: number | string }>(
    `SELECT d.source_identity, c.id AS chunk_id, 1 - (e.embedding <=> $2::vector) AS similarity
       FROM aegis.chunk_embeddings e
       JOIN aegis.document_chunks c ON c.id = e.chunk_id AND c.tenant_id = e.tenant_id
       JOIN aegis.documents d ON d.tenant_id = c.tenant_id AND d.id = c.document_id
         AND d.version = c.document_version AND d.source_identity = c.source_identity
      WHERE e.tenant_id = $1 AND e.model = $3
      ORDER BY e.embedding <=> $2::vector, c.id
      LIMIT $4`,
    [tenantId, literal, EMBEDDING_MODEL, topK],
  );
  return result.rows.map((row) => ({ sourceIdentity: row.source_identity, chunkId: row.chunk_id, similarity: Number(row.similarity) }));
}

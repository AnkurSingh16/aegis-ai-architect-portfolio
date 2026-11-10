import type { PoolClient } from 'pg';

export const retrievalLimits = Object.freeze({ maxQueryCharacters: 256, maxQueryBytes: 512, maxTopK: 5,
  maxChunkBytes: 8192, maxContextBytes: 12 * 1024, statementTimeoutMs: 1200, minimumRank: 0.015 });

export interface RetrievedChunk {
  chunkId: string;
  sourceIdentity: string;
  version: number;
  position: number;
  title: string;
  content: string;
  rank: number;
}

export class RetrievalError extends Error {
  constructor(readonly code: 'invalid_query' | 'unavailable') { super('Document retrieval is unavailable.'); }
}

export function normalizeRetrievalQuery(value: unknown): string {
  if (typeof value !== 'string') throw new RetrievalError('invalid_query');
  const query = value.normalize('NFKC').trim().replace(/\s+/gu, ' ');
  if (query.length < 1 || query.length > retrievalLimits.maxQueryCharacters ||
      Buffer.byteLength(query, 'utf8') > retrievalLimits.maxQueryBytes || [...query].some((character) => {
        const code = character.codePointAt(0) ?? 0;
        return code < 0x20 && code !== 0x09 && code !== 0x0a || code === 0x7f;
      })) {
    throw new RetrievalError('invalid_query');
  }
  return query;
}

/** Caller must provide the checked-out client from withAuthenticatedTransaction. */
export async function retrieveDocumentChunks(client: PoolClient, tenantId: string, rawQuery: unknown): Promise<RetrievedChunk[]> {
  const query = normalizeRetrievalQuery(rawQuery);
  try {
    await client.query("SELECT set_config('statement_timeout',$1,true)", [`${retrievalLimits.statementTimeoutMs}ms`]);
    const result = await client.query<{
      chunk_id: string; source_identity: string; document_version: number; position: number; title: string | null;
      content: string; rank: number | string;
    }>(`WITH parsed AS (SELECT plainto_tsquery('english'::regconfig,$1) AS query), ranked AS (
      SELECT c.id AS chunk_id,d.source_identity,d.version AS document_version,c.position,
        d.metadata->>'title' AS title,c.content,ts_rank_cd(c.search_vector,p.query) AS rank
      FROM aegis.document_chunks c JOIN aegis.documents d
        ON d.tenant_id=c.tenant_id AND d.id=c.document_id AND d.version=c.document_version AND d.source_identity=c.source_identity
      CROSS JOIN parsed p WHERE c.tenant_id=$2 AND c.search_vector @@ p.query
    ) SELECT chunk_id,source_identity,document_version,position,title,content,rank FROM ranked
      WHERE rank >= $3 ORDER BY rank DESC,source_identity ASC,document_version DESC,position ASC,chunk_id ASC LIMIT $4`,
    [query, tenantId, retrievalLimits.minimumRank, retrievalLimits.maxTopK]);
    const rows = result.rows;
    const output: RetrievedChunk[] = [];
    let contextBytes = 0;
    for (const row of rows) {
      const contentBytes = Buffer.byteLength(row.content, 'utf8');
      const title = typeof row.title === 'string' && row.title.length > 0 && row.title.length <= 160 ? row.title : 'Synthetic support document';
      const metadataBytes = Buffer.byteLength(title, 'utf8');
      if (contentBytes > retrievalLimits.maxChunkBytes) throw new RetrievalError('unavailable');
      if (contextBytes + contentBytes + metadataBytes > retrievalLimits.maxContextBytes) break;
      const rank = Number(row.rank);
      if (!Number.isFinite(rank) || rank < retrievalLimits.minimumRank) throw new RetrievalError('unavailable');
      contextBytes += contentBytes + metadataBytes;
      output.push({ chunkId: row.chunk_id, sourceIdentity: row.source_identity, version: row.document_version,
        position: row.position, title, content: row.content, rank });
    }
    return output;
  } catch (error) {
    if (error instanceof RetrievalError) throw error;
    throw new RetrievalError('unavailable');
  }
}

import type { PoolClient } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { EMBEDDING_DIMENSIONS } from '../retrieval/ollama-embeddings.js';
import { vectorEvidenceRetriever, type ClientRunner } from './document-evidence.js';

const vector = Array.from({ length: EMBEDDING_DIMENSIONS }, (_, i) => (i === 0 ? 1 : 0));

function fakeRunner(rows: Record<string, unknown>[]) {
  const query = vi.fn<(sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>>(async () => ({ rows }));
  const run: ClientRunner = (operation) => operation({ query } as unknown as PoolClient);
  return { run, query };
}

describe('vectorEvidenceRetriever', () => {
  it('maps nearest chunks to evidence, scored by similarity, and asks for the requested top-k', async () => {
    const { run, query } = fakeRunner([
      { source_identity: 'SYNTHETIC-NORTH-MFA-GUIDANCE', chunk_id: 'c1', content: 'Check the test factor.', similarity: '0.71' },
      { source_identity: 'SYNTHETIC-NORTH-LOGIN-INCIDENT', chunk_id: 'c2', content: 'Record the time window.', similarity: 0.42 },
    ]);
    const retrieve = vectorEvidenceRetriever({ run, tenantId: '00000000-0000-4000-8000-000000000001', embedQuery: async () => vector, topK: 3 });
    const evidence = await retrieve('how do I check a factor');
    expect(evidence).toEqual([
      { sourceId: 'SYNTHETIC-NORTH-MFA-GUIDANCE', text: 'Check the test factor.', score: 0.71 },
      { sourceId: 'SYNTHETIC-NORTH-LOGIN-INCIDENT', text: 'Record the time window.', score: 0.42 },
    ]);
    expect(query.mock.calls[0]?.[1]).toEqual(['00000000-0000-4000-8000-000000000001', expect.any(String), 'nomic-embed-text', 3]);
  });

  it('propagates an embedding failure and never queries the database', async () => {
    const { run, query } = fakeRunner([]);
    const retrieve = vectorEvidenceRetriever({
      run, tenantId: '00000000-0000-4000-8000-000000000001',
      embedQuery: async () => { throw new Error('embedding service unavailable'); },
    });
    await expect(retrieve('anything')).rejects.toThrow('embedding service unavailable');
    expect(query).not.toHaveBeenCalled();
  });

  it('returns no evidence when nothing is stored for the tenant', async () => {
    const { run } = fakeRunner([]);
    const retrieve = vectorEvidenceRetriever({ run, tenantId: '00000000-0000-4000-8000-000000000001', embedQuery: async () => vector });
    await expect(retrieve('anything')).resolves.toEqual([]);
  });
});

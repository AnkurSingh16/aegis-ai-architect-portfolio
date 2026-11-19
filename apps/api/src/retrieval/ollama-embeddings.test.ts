import { describe, expect, it } from 'vitest';
import { EMBEDDING_DIMENSIONS, EmbeddingError, embedTexts, toVectorLiteral } from './ollama-embeddings.js';

const vector = (value = 0.5) => Array.from({ length: EMBEDDING_DIMENSIONS }, () => value);
const fakeFetch = (body: unknown, ok = true, status = 200) => async (url: string, init: { body: string }) => {
  void url; void init;
  return { ok, status, json: async () => body };
};

describe('local embedding client', () => {
  it('sends a prefixed batch to loopback and returns validated vectors', async () => {
    let sent: { url: string; body: string } | undefined;
    const fetchImpl = async (url: string, init: { body: string }) => { sent = { url, body: init.body }; return { ok: true, status: 200, json: async () => ({ embeddings: [vector(), vector()] }) }; };
    const result = await embedTexts(['a', 'b'], 'search_query', fetchImpl);
    expect(result).toHaveLength(2);
    expect(sent?.url).toBe('http://127.0.0.1:11434/api/embed');
    expect(JSON.parse(sent!.body)).toEqual({ model: 'nomic-embed-text', input: ['search_query: a', 'search_query: b'] });
  });

  it('refuses empty, oversized and over-batched inputs before calling the service', async () => {
    const never = async () => { throw new Error('must not be called'); };
    await expect(embedTexts([], 'search_query', never)).rejects.toThrow(EmbeddingError);
    await expect(embedTexts(Array(9).fill('x'), 'search_query', never)).rejects.toThrow(EmbeddingError);
    await expect(embedTexts(['x'.repeat(8193)], 'search_query', never)).rejects.toThrow(EmbeddingError);
  });

  it('rejects wrong counts, wrong dimensions, non-finite values and HTTP errors', async () => {
    await expect(embedTexts(['a'], 'search_document', fakeFetch({ embeddings: [] }))).rejects.toThrow(/count/);
    await expect(embedTexts(['a'], 'search_document', fakeFetch({ embeddings: [[1, 2, 3]] }))).rejects.toThrow(/shape/);
    await expect(embedTexts(['a'], 'search_document', fakeFetch({ embeddings: [[...vector().slice(1), Number.NaN]] }))).rejects.toThrow(/shape/);
    await expect(embedTexts(['a'], 'search_document', fakeFetch({}, false, 500))).rejects.toThrow(/HTTP 500/);
  });

  it('reports unavailability without leaking transport details', async () => {
    const down = async () => { throw new Error('connect ECONNREFUSED 127.0.0.1:11434 secret-detail'); };
    await expect(embedTexts(['a'], 'search_query', down)).rejects.toThrow('embedding service unavailable');
  });

  it('builds a vector literal only from valid finite numbers', () => {
    expect(toVectorLiteral(vector(1)).startsWith('[1,1')).toBe(true);
    expect(() => toVectorLiteral([1, 2])).toThrow(EmbeddingError);
    expect(() => toVectorLiteral([...vector().slice(1), Infinity])).toThrow(EmbeddingError);
  });
});

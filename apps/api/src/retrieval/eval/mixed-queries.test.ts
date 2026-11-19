import { describe, expect, it } from 'vitest';
import { tokenize } from './bm25.js';
import { largeCorpusDocuments } from './large-dev-corpus.js';
import { mixedRetrievalQueries } from './mixed-queries.js';

describe('mixed development queries', () => {
  const queries = mixedRetrievalQueries();

  it('has 100 queries split evenly into dev and test, deterministically', () => {
    expect(queries).toHaveLength(100);
    expect(queries.filter((q) => q.split === 'dev')).toHaveLength(50);
    expect(mixedRetrievalQueries()).toEqual(queries);
  });

  it('adds one to three target content words to every augmented query', () => {
    const byId = new Map<string, Set<string>>(largeCorpusDocuments.map((doc) => [doc.id, new Set(tokenize(doc.text))]));
    for (const q of queries.filter((row) => row.kind === 'augmented')) {
      const overlap = tokenize(q.query).filter((token) => byId.get(q.target)!.has(token)).length;
      expect(overlap, q.id).toBeGreaterThanOrEqual(1);
      expect(q.overlap).toBeGreaterThanOrEqual(1);
      expect(q.overlap).toBeLessThanOrEqual(3);
    }
  });

  it('keeps the pure paraphrases free of target words', () => {
    expect(queries.filter((q) => q.kind === 'paraphrase').every((q) => q.overlap === 0)).toBe(true);
  });
});

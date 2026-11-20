import { describe, expect, it } from 'vitest';
import { bm25Rank, tokenize } from './bm25.js';
import { largeCorpusDocuments, largeCorpusQueries } from './large-dev-corpus.js';

describe('large development retrieval corpus', () => {
  it('has unique ids, one query per document, and every target exists', () => {
    const docIds = largeCorpusDocuments.map((doc) => doc.id);
    expect(new Set(docIds).size).toBe(docIds.length);
    expect(largeCorpusDocuments).toHaveLength(50);
    expect(largeCorpusQueries).toHaveLength(50);
    expect(new Set(largeCorpusQueries.map((q) => q.target))).toEqual(new Set(docIds));
  });

  it('keeps paraphrase queries free of their target document\'s content words', () => {
    const byId = new Map(largeCorpusDocuments.map((doc) => [doc.id, doc.text]));
    const violations = largeCorpusQueries.flatMap((q) => {
      const docTokens = new Set(tokenize(byId.get(q.target) ?? ''));
      return tokenize(q.query).filter((token) => docTokens.has(token)).map((token) => `${q.id}:${token}`);
    });
    expect(violations).toEqual([]);
  });
});

describe('BM25 baseline', () => {
  it('ranks the document with matching terms first and omits zero-score documents', () => {
    const docs = [
      { id: 'a', text: 'refund policy for duplicate charges' },
      { id: 'b', text: 'firmware update signed packages' },
      { id: 'c', text: 'shipping address changes' },
    ];
    expect(bm25Rank('duplicate charge refund', docs)).toEqual(['a']);
    expect(bm25Rank('nothing relevant here at all', docs)).toEqual([]);
  });

  it('is deterministic under ties', () => {
    const docs = [{ id: 'y', text: 'alpha beta' }, { id: 'x', text: 'alpha beta' }];
    expect(bm25Rank('alpha', docs)).toEqual(['x', 'y']);
  });
});

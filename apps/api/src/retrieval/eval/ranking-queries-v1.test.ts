import { describe, expect, it } from 'vitest';
import { contentWords, rankingQueriesV1, targetOverlap, targetTextFor } from './ranking-queries-v1.js';
import { largeCorpusDocuments, largeCorpusQueries } from './large-dev-corpus.js';
import { mixedRetrievalQueries } from './mixed-queries.js';

describe('ranking queries v1', () => {
  it('has fifty queries, one per document, with unique ids', () => {
    expect(rankingQueriesV1).toHaveLength(50);
    expect(new Set(rankingQueriesV1.map((q) => q.id)).size).toBe(50);
    expect(new Set(rankingQueriesV1.map((q) => q.target)).size).toBe(50);
    expect(largeCorpusDocuments.map((d) => d.id).sort()).toEqual(rankingQueriesV1.map((q) => q.target).sort());
  });

  it('has twenty-five paraphrases on odd documents and twenty-five augmented on even documents', () => {
    const paraphrases = rankingQueriesV1.filter((q) => q.kind === 'paraphrase');
    const augmented = rankingQueriesV1.filter((q) => q.kind === 'augmented');
    expect(paraphrases).toHaveLength(25);
    expect(augmented).toHaveLength(25);
    for (const q of paraphrases) expect(Number(q.target.slice(1)) % 2).toBe(1);
    for (const q of augmented) expect(Number(q.target.slice(1)) % 2).toBe(0);
  });

  it('keeps paraphrases free of target content words', () => {
    const leaks = rankingQueriesV1
      .filter((q) => q.kind === 'paraphrase')
      .map((q) => ({ id: q.id, overlap: targetOverlap(q.query, targetTextFor(q.target)) }))
      .filter((row) => row.overlap > 0);
    expect(leaks).toEqual([]);
  });

  it('adds one to three target content words to every augmented query', () => {
    const counts = rankingQueriesV1
      .filter((q) => q.kind === 'augmented')
      .map((q) => ({ id: q.id, overlap: targetOverlap(q.query, targetTextFor(q.target)) }));
    expect(counts.filter((row) => row.overlap < 1 || row.overlap > 3)).toEqual([]);
  });

  it('shares no query wording with the mixed set or the paraphrases in large-dev-corpus.ts', () => {
    const earlier = new Set([
      ...largeCorpusQueries.map((q) => q.query.toLowerCase()),
      ...mixedRetrievalQueries().map((q) => q.query.toLowerCase()),
    ]);
    expect(rankingQueriesV1.filter((q) => earlier.has(q.query.toLowerCase())).map((q) => q.id)).toEqual([]);
  });

  it('computes content words without stopwords', () => {
    expect(contentWords('The bill for the month')).toEqual(['bill', 'month']);
  });
});

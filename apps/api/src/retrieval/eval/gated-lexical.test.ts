import { describe, expect, it } from 'vitest';
import { GATE, gatedLexicalRank, type ScoredId } from './gated-lexical.js';

const vector: ScoredId[] = [
  { id: 'A', score: 0.80 }, { id: 'B', score: 0.79 }, { id: 'C', score: 0.70 }, { id: 'D', score: 0.60 },
];

describe('gatedLexicalRank', () => {
  it('uses the pre-registered parameters', () => {
    expect(GATE).toEqual({ nearTieMargin: 0.02, lexicalFactor: 2, topN: 10 });
  });

  it('promotes a near-tie runner-up when BM25 is clearly confident', () => {
    expect(gatedLexicalRank(vector, [{ id: 'B', score: 5 }, { id: 'C', score: 2 }])).toEqual(['B', 'A', 'C', 'D']);
  });

  it('keeps vector order when the lexical lead is not at least double', () => {
    expect(gatedLexicalRank(vector, [{ id: 'B', score: 5 }, { id: 'C', score: 3 }])).toEqual(['A', 'B', 'C', 'D']);
  });

  it('keeps vector order when the lexical top is not in the near-tie margin', () => {
    expect(gatedLexicalRank(vector, [{ id: 'C', score: 5 }, { id: 'D', score: 1 }])).toEqual(['A', 'B', 'C', 'D']);
  });

  it('does not promote the vector top document, and keeps vector order when it is already first', () => {
    expect(gatedLexicalRank(vector, [{ id: 'A', score: 5 }, { id: 'B', score: 1 }])).toEqual(['A', 'B', 'C', 'D']);
  });

  it('keeps vector order when there is no positive lexical score', () => {
    expect(gatedLexicalRank(vector, [])).toEqual(['A', 'B', 'C', 'D']);
  });

  it('treats a single lexical match as confident when it is within the margin', () => {
    expect(gatedLexicalRank(vector, [{ id: 'B', score: 1 }])).toEqual(['B', 'A', 'C', 'D']);
  });

  it('promotes inside the near-tie margin and keeps order outside it', () => {
    const inside: ScoredId[] = [{ id: 'A', score: 0.8 }, { id: 'B', score: 0.79 }];
    expect(gatedLexicalRank(inside, [{ id: 'B', score: 4 }])).toEqual(['B', 'A']);
    const outside: ScoredId[] = [{ id: 'A', score: 0.8 }, { id: 'B', score: 0.77 }];
    expect(gatedLexicalRank(outside, [{ id: 'B', score: 4 }])).toEqual(['A', 'B']);
  });

  it('never moves a document from outside the vector top ten', () => {
    const long: ScoredId[] = Array.from({ length: 12 }, (_, i) => ({ id: `X${i}`, score: 0.5 - i * 0.001 }));
    expect(gatedLexicalRank(long, [{ id: 'X10', score: 9 }])).toEqual(long.map((row) => row.id));
  });

  it('returns every document exactly once, and only the promoted one changes position', () => {
    const ranked = gatedLexicalRank(vector, [{ id: 'B', score: 5 }]);
    expect([...ranked].sort()).toEqual(['A', 'B', 'C', 'D']);
    expect(ranked.indexOf('C')).toBe(2);
    expect(ranked.indexOf('D')).toBe(3);
  });
});

import { describe, expect, it } from 'vitest';
import { meanReciprocalRank, ndcgAtK, recallAtK, reciprocalRank, reciprocalRankFusion } from './ranking-metrics.js';

describe('ranking metrics', () => {
  it('computes recall@K against the relevant set', () => {
    const relevant = new Set(['a', 'b', 'c']);
    expect(recallAtK(['a', 'x', 'b', 'y', 'c'], relevant, 3)).toBeCloseTo(2 / 3);
    expect(recallAtK(['a', 'x', 'b', 'y', 'c'], relevant, 5)).toBe(1);
    expect(recallAtK(['x'], new Set(), 1)).toBe(0);
  });

  it('computes reciprocal rank and MRR', () => {
    expect(reciprocalRank(['x', 'a'], new Set(['a']))).toBe(0.5);
    expect(reciprocalRank(['x'], new Set(['a']))).toBe(0);
    expect(meanReciprocalRank([
      { ranked: ['a'], relevant: new Set(['a']) },
      { ranked: ['x', 'a'], relevant: new Set(['a']) },
      { ranked: ['x'], relevant: new Set(['a']) },
    ])).toBeCloseTo((1 + 0.5 + 0) / 3);
  });

  it('computes nDCG with graded gains and matches the ideal ordering at 1', () => {
    const grades = new Map([['a', 3], ['b', 2], ['c', 1]]);
    expect(ndcgAtK(['a', 'b', 'c'], grades, 3)).toBeCloseTo(1);
    const reversed = ndcgAtK(['c', 'b', 'a'], grades, 3);
    expect(reversed).toBeLessThan(1);
    expect(reversed).toBeGreaterThan(0);
    expect(ndcgAtK(['x'], new Map(), 3)).toBe(0);
  });

  it('rejects non-positive K', () => {
    expect(() => recallAtK(['a'], new Set(['a']), 0)).toThrow(RangeError);
    expect(() => ndcgAtK(['a'], new Map([['a', 1]]), 1.5)).toThrow(RangeError);
  });
});

describe('reciprocal rank fusion', () => {
  it('rewards documents ranked well by several lists', () => {
    const lexical = ['a', 'b', 'c'];
    const vector = ['c', 'a', 'd'];
    const fused = reciprocalRankFusion([lexical, vector]);
    expect(fused[0]).toBe('a');
    expect(fused).toEqual(expect.arrayContaining(['a', 'b', 'c', 'd']));
    expect(fused).toHaveLength(4);
  });

  it('is deterministic with ties broken by id and counts a duplicate inside one list once', () => {
    expect(reciprocalRankFusion([['b'], ['a']])).toEqual(['a', 'b']);
    expect(reciprocalRankFusion([['a', 'a', 'b']])).toEqual(['a', 'b']);
  });

  it('rejects invalid k0', () => {
    expect(() => reciprocalRankFusion([['a']], -1)).toThrow(RangeError);
  });
});

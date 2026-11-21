import { describe, expect, it } from 'vitest';
import { reciprocalRankFusion, weightedReciprocalRankFusion } from './ranking-metrics.js';

// Deterministic invariants of the fusion code. No model, no database.
const lexical = ['d3', 'd1', 'd5', 'd2'];
const vector = ['d1', 'd2', 'd4', 'd3'];

describe('reciprocal rank fusion invariants', () => {
  it('a single list fuses to itself', () => {
    expect(reciprocalRankFusion([vector])).toEqual(vector);
  });

  it('identical lists fuse to the same order', () => {
    expect(reciprocalRankFusion([vector, vector])).toEqual(vector);
  });

  it('an id repeated within one list counts once, so a duplicate cannot raise an item', () => {
    expect(reciprocalRankFusion([['a', 'a', 'b'], ['b', 'a']])).toEqual(reciprocalRankFusion([['a', 'b'], ['b', 'a']]));
  });

  it('is deterministic: ties break on id, and repeated calls return the same order', () => {
    const tied = [['x', 'y'], ['y', 'x']];
    expect(reciprocalRankFusion(tied)).toEqual(['x', 'y']);
    expect(reciprocalRankFusion(tied)).toEqual(reciprocalRankFusion(tied));
  });

  it('rejects a negative k0', () => {
    expect(() => reciprocalRankFusion([vector], -1)).toThrow(RangeError);
  });
});

describe('weighted reciprocal rank fusion invariants', () => {
  // Items from the zero-weight list still appear in the output, scored at zero and placed after the weighted items. So the
  // invariant is that the weighted list forms the prefix, in its own order.
  it('w = 0 orders the vector items exactly as the vector ranking (the tuned choice recorded in the register)', () => {
    const fused = weightedReciprocalRankFusion(lexical, vector, 0);
    expect(fused.slice(0, vector.length)).toEqual(vector);
    expect(fused.slice(vector.length)).toEqual(lexical.filter((id) => !vector.includes(id)));
  });

  it('w = 1 orders the lexical items exactly as the lexical ranking', () => {
    const fused = weightedReciprocalRankFusion(lexical, vector, 1);
    expect(fused.slice(0, lexical.length)).toEqual(lexical);
    expect(fused.slice(lexical.length)).toEqual(vector.filter((id) => !lexical.includes(id)));
  });

  it('w = 0.5 agrees with equal-weight reciprocal rank fusion on the top item', () => {
    expect(weightedReciprocalRankFusion(lexical, vector, 0.5)[0]).toBe(reciprocalRankFusion([lexical, vector])[0]);
  });

  it('rejects a weight outside 0 to 1', () => {
    expect(() => weightedReciprocalRankFusion(lexical, vector, -0.1)).toThrow(RangeError);
    expect(() => weightedReciprocalRankFusion(lexical, vector, 1.1)).toThrow(RangeError);
  });

  it('returns every item from both lists exactly once', () => {
    const fused = weightedReciprocalRankFusion(lexical, vector, 0.3);
    expect([...fused].sort()).toEqual(['d1', 'd2', 'd3', 'd4', 'd5']);
  });
});

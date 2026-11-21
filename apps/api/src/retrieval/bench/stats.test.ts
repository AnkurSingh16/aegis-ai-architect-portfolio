import { describe, expect, it } from 'vitest';
import { percentile, summarize } from './stats.js';

describe('latency statistics', () => {
  it('uses nearest-rank percentiles', () => {
    const sorted = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(percentile(sorted, 50)).toBe(50);
    expect(percentile(sorted, 95)).toBe(95);
    expect(percentile(sorted, 100)).toBe(100);
  });

  it('summarises an empty sample without inventing numbers', () => {
    expect(summarize([])).toEqual({ n: 0, p50: null, p95: null, mean: null, min: null, max: null });
  });

  it('reports the sample size, so a reader can judge how much a p95 means', () => {
    const s = summarize([3, 1, 2]);
    expect(s).toMatchObject({ n: 3, p50: 2, min: 1, max: 3 });
  });

  it('rejects an invalid percentile', () => {
    expect(() => percentile([1], 0)).toThrow(RangeError);
    expect(() => percentile([1], 101)).toThrow(RangeError);
  });
});

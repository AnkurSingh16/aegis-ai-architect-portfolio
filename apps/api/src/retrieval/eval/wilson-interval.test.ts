import { describe, expect, it } from 'vitest';
import { wilsonInterval } from './wilson-interval.js';

const close = (actual: number, expected: number) => expect(Math.abs(actual - expected)).toBeLessThan(0.001);

describe('wilsonInterval', () => {
  it('matches the published Wilson values for 0 of 10 and 10 of 10', () => {
    const none = wilsonInterval(0, 10)!;
    close(none.low, 0);
    close(none.high, 0.2775);
    const all = wilsonInterval(10, 10)!;
    close(all.low, 0.7225);
    close(all.high, 1);
  });

  it('is centred on the proportion for 5 of 10', () => {
    const mid = wilsonInterval(5, 10)!;
    close(mid.low, 0.2366);
    close(mid.high, 0.7634);
  });

  it('narrows as the number of trials grows', () => {
    const small = wilsonInterval(7, 12)!;
    const large = wilsonInterval(70, 120)!;
    expect(large.high - large.low).toBeLessThan(small.high - small.low);
  });

  it('returns null when there are no trials or the counts are invalid', () => {
    expect(wilsonInterval(0, 0)).toBeNull();
    expect(wilsonInterval(3, 2)).toBeNull();
    expect(wilsonInterval(-1, 5)).toBeNull();
    expect(wilsonInterval(1.5, 5)).toBeNull();
  });
});

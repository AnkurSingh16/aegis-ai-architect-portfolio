import { describe, expect, it } from 'vitest';
import { createTokenBucketLimiter } from './rate-limiter.js';

const at = (ms: number) => new Date(Date.UTC(2026, 10, 20, 9, 0, 0) + ms);

describe('token-bucket rate limiter', () => {
  it('allows a burst up to capacity, then refuses until tokens refill', () => {
    const limiter = createTokenBucketLimiter({ capacity: 2, refillPerSecond: 1 });
    expect([limiter.take('k', at(0)), limiter.take('k', at(0)), limiter.take('k', at(0))]).toEqual([true, true, false]);
    expect(limiter.take('k', at(999))).toBe(false);
    expect(limiter.take('k', at(1000))).toBe(true);
  });

  it('keeps keys independent, so one tenant or agent cannot exhaust another', () => {
    const limiter = createTokenBucketLimiter({ capacity: 1, refillPerSecond: 0.001 });
    expect(limiter.take('tenant-a|agent', at(0))).toBe(true);
    expect(limiter.take('tenant-a|agent', at(0))).toBe(false);
    expect(limiter.take('tenant-b|agent', at(0))).toBe(true);
  });

  it('never refills above capacity, even after a long idle period', () => {
    const limiter = createTokenBucketLimiter({ capacity: 2, refillPerSecond: 100 });
    limiter.take('k', at(0));
    expect(limiter.take('k', at(3_600_000))).toBe(true);
    expect(limiter.take('k', at(3_600_000))).toBe(true);
    expect(limiter.take('k', at(3_600_000))).toBe(false);
  });

  it('treats a clock that goes backwards as no refill, not as a negative balance', () => {
    const limiter = createTokenBucketLimiter({ capacity: 1, refillPerSecond: 1 });
    expect(limiter.take('k', at(5000))).toBe(true);
    expect(limiter.take('k', at(0))).toBe(false);
  });

  it('bounds the number of tracked keys', () => {
    const limiter = createTokenBucketLimiter({ capacity: 1, refillPerSecond: 0.001, maxKeys: 2 });
    limiter.take('a', at(0));
    limiter.take('b', at(0));
    limiter.take('c', at(0));
    // 'a' was the least recently used and was dropped, so it starts again with a full bucket.
    expect(limiter.take('a', at(0))).toBe(true);
  });

  it('rejects invalid options', () => {
    expect(() => createTokenBucketLimiter({ capacity: 0, refillPerSecond: 1 })).toThrow(RangeError);
    expect(() => createTokenBucketLimiter({ capacity: 1, refillPerSecond: 0 })).toThrow(RangeError);
    expect(() => createTokenBucketLimiter({ capacity: 1, refillPerSecond: 1, maxKeys: 0 })).toThrow(RangeError);
  });
});

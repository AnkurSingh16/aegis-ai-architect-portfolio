/** A request to take one token for a tenant's registered agent. */
export interface RateLimitRequest {
  readonly tenantId: string;
  readonly agentId: string;
  readonly now: Date;
}

/**
 * The gateway's view of a rate limiter. It may be shared (PostgreSQL) or in process. A rejected promise means the limiter
 * could not decide; the gateway denies the call (fail closed).
 */
export interface RateLimiter {
  take(request: RateLimitRequest): Promise<boolean>;
}

/**
 * Token-bucket rate limiter, in process. Pure apart from its own map. The caller supplies the clock, so behaviour is
 * deterministic in tests. It is per process: several API instances do not share a count. A shared limit needs a shared
 * store, which is recorded as a remaining gap in the C10 register row.
 */
export interface BucketLimiter {
  /** Takes one token for the key. Returns false when the bucket is empty. */
  take(key: string, now: Date): boolean;
}

/** Adapts the in-process bucket to the gateway's RateLimiter, keyed by tenant and agent. */
export function inProcessRateLimiter(bucket: BucketLimiter): RateLimiter {
  return { take: async ({ tenantId, agentId, now }) => bucket.take(`${tenantId}|${agentId}`, now) };
}

export interface TokenBucketOptions {
  /** Maximum tokens a key can hold (the burst size). */
  readonly capacity: number;
  /** Tokens added per second. */
  readonly refillPerSecond: number;
  /** Bounds memory: at most this many keys are tracked. The least recently used key is dropped first. */
  readonly maxKeys?: number;
}

export function createTokenBucketLimiter(options: TokenBucketOptions): BucketLimiter {
  if (!Number.isInteger(options.capacity) || options.capacity < 1) throw new RangeError('capacity must be a positive integer');
  if (!Number.isFinite(options.refillPerSecond) || options.refillPerSecond <= 0) throw new RangeError('refillPerSecond must be positive');
  const maxKeys = options.maxKeys ?? 10_000;
  if (!Number.isInteger(maxKeys) || maxKeys < 1) throw new RangeError('maxKeys must be a positive integer');
  const buckets = new Map<string, { tokens: number; updatedMs: number }>();
  return {
    take(key, now) {
      const nowMs = now.getTime();
      const existing = buckets.get(key);
      const bucket = existing ?? { tokens: options.capacity, updatedMs: nowMs };
      const elapsedSeconds = Math.max(0, nowMs - bucket.updatedMs) / 1000;
      bucket.tokens = Math.min(options.capacity, bucket.tokens + elapsedSeconds * options.refillPerSecond);
      bucket.updatedMs = nowMs;
      // Re-insert so the map keeps insertion order as recency order.
      buckets.delete(key);
      if (buckets.size >= maxKeys) buckets.delete(buckets.keys().next().value as string);
      buckets.set(key, bucket);
      if (bucket.tokens < 1) return false;
      bucket.tokens -= 1;
      return true;
    },
  };
}

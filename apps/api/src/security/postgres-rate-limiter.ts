import type { TenantRunner } from './tool-approval-store.js';
import type { RateLimiter, RateLimitRequest } from './rate-limiter.js';

/**
 * Shared token bucket in PostgreSQL. A take is one conditional upsert, so two workers cannot both spend the last token.
 * Refill uses the database clock (now()), so worker clock skew cannot grant extra tokens. A database error propagates;
 * the gateway treats it as a denial (fail closed).
 *
 * The bucket key is the registered agent id. The gateway calls this only for registered, active agents, so callers cannot
 * create rows by inventing agent ids. Each tenant holds at most one row per registered agent.
 */
export interface PostgresRateLimitOptions {
  /** Maximum tokens (burst). Development value, not production-calibrated. */
  readonly capacity: number;
  /** Tokens added per second. Development value, not production-calibrated. */
  readonly refillPerSecond: number;
}

export function createPostgresRateLimiter(runTenant: TenantRunner, options: PostgresRateLimitOptions): RateLimiter {
  if (!Number.isInteger(options.capacity) || options.capacity < 1) throw new RangeError('capacity must be a positive integer');
  if (!Number.isFinite(options.refillPerSecond) || options.refillPerSecond <= 0) throw new RangeError('refillPerSecond must be positive');
  return {
    async take({ tenantId, agentId }: RateLimitRequest): Promise<boolean> {
      if (agentId.length === 0 || agentId.length > 128) throw new RangeError('agentId must be 1 to 128 characters');
      return runTenant(tenantId, async (client) => {
        const result = await client.query<{ tokens: number }>(
          `INSERT INTO aegis.rate_limit_buckets AS b (tenant_id, bucket_key, tokens, updated_at)
           VALUES ($1, $2, $3 - 1, now())
           ON CONFLICT (tenant_id, bucket_key) DO UPDATE
              SET tokens = LEAST($3, b.tokens + GREATEST(0, EXTRACT(EPOCH FROM (now() - b.updated_at))) * $4) - 1,
                  updated_at = now()
            WHERE LEAST($3, b.tokens + GREATEST(0, EXTRACT(EPOCH FROM (now() - b.updated_at))) * $4) >= 1
           RETURNING tokens`,
          [tenantId, agentId, options.capacity, options.refillPerSecond],
        );
        // No row back means the conditional update found too few tokens: the call is limited.
        return result.rows.length === 1;
      });
    },
  };
}

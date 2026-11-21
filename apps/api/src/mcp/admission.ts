import { createTokenBucketLimiter } from '../security/rate-limiter.js';

/**
 * Admission control for MCP tool calls. It runs before any credential verification, membership query or gateway work, so a flood
 * of calls cannot reach the database pool. It complements the gateway's PostgreSQL rate limiter, which still runs for every call
 * that is admitted. It never grants anything: an admitted call still needs the full authentication, membership and gateway checks.
 *
 * Two bounds apply per process: a token bucket (burst and refill) and a cap on calls in flight. Both are per process, so several
 * server processes each have their own bounds. That is acceptable for the local stdio transport and is documented as a limitation.
 */
export interface AdmissionOptions {
  /** Maximum calls admitted in a burst. */
  readonly burst: number;
  /** Calls admitted back per second. */
  readonly refillPerSecond: number;
  /** Maximum calls in flight at once. Keep this below the database pool size. */
  readonly maxConcurrent: number;
}

/** Defaults sized for a single local user. The pool holds 4 connections in stdio.ts, so at most 2 calls run at once. */
export const DEFAULT_ADMISSION: AdmissionOptions = { burst: 30, refillPerSecond: 5, maxConcurrent: 2 };

export type AdmissionRefusal = 'admission_throttled' | 'admission_saturated';

export type AdmissionDecision =
  | { readonly admitted: true; readonly release: () => void }
  | { readonly admitted: false; readonly reason: AdmissionRefusal };

export interface AdmissionController {
  admit(now: Date): AdmissionDecision;
  inFlight(): number;
}

const BUCKET_KEY = 'mcp-admission';

export function createAdmissionController(options: AdmissionOptions): AdmissionController {
  for (const [name, value] of Object.entries({ burst: options.burst, maxConcurrent: options.maxConcurrent })) {
    if (!Number.isInteger(value) || value < 1) throw new RangeError(`${name} must be a positive integer`);
  }
  if (!(options.refillPerSecond > 0) || !Number.isFinite(options.refillPerSecond)) {
    throw new RangeError('refillPerSecond must be a positive number');
  }
  const bucket = createTokenBucketLimiter({ capacity: options.burst, refillPerSecond: options.refillPerSecond });
  let inFlight = 0;
  return {
    admit(now: Date): AdmissionDecision {
      // The token is taken first, so a flood consumes tokens even when the concurrency cap refuses it.
      if (!bucket.take(BUCKET_KEY, now)) return { admitted: false, reason: 'admission_throttled' };
      if (inFlight >= options.maxConcurrent) return { admitted: false, reason: 'admission_saturated' };
      inFlight += 1;
      let released = false;
      return {
        admitted: true,
        release: () => {
          if (released) return;
          released = true;
          inFlight -= 1;
        },
      };
    },
    inFlight: () => inFlight,
  };
}

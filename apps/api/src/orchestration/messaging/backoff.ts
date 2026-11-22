/**
 * Retry delay for a failed delivery. Exponential in the number of attempts made so far, capped, with jitter so that dispatchers that
 * failed together do not retry together. The delay is added to the database clock (clock_timestamp()), never to a worker clock.
 */
export const BACKOFF_BASE_SECONDS = 1;
export const BACKOFF_CAP_SECONDS = 60;

export function backoffSeconds(attempts: number, random: () => number = Math.random): number {
  if (!Number.isInteger(attempts) || attempts < 1) throw new RangeError('attempts must be a positive integer');
  const exponential = Math.min(BACKOFF_CAP_SECONDS, BACKOFF_BASE_SECONDS * 2 ** (attempts - 1));
  const jitter = 0.8 + 0.4 * random();
  return Math.min(BACKOFF_CAP_SECONDS, exponential * jitter);
}

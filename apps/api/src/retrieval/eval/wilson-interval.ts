/**
 * Wilson score interval for a proportion. Used for reporting only: recall, abstention precision and the false-answer rate
 * are reported with it. Pure, deterministic.
 */
export interface Interval { readonly low: number; readonly high: number }

/** Two-sided interval at the given z (1.96 for 95 percent). Returns null when there are no trials. */
export function wilsonInterval(successes: number, trials: number, z = 1.96): Interval | null {
  if (!Number.isInteger(successes) || !Number.isInteger(trials) || trials <= 0 || successes < 0 || successes > trials) return null;
  const p = successes / trials;
  const z2 = z * z;
  const denominator = 1 + z2 / trials;
  const centre = (p + z2 / (2 * trials)) / denominator;
  const half = (z * Math.sqrt((p * (1 - p)) / trials + z2 / (4 * trials * trials))) / denominator;
  return { low: Math.max(0, centre - half), high: Math.min(1, centre + half) };
}

/** Latency statistics. Nearest-rank percentiles on a sorted copy of the samples. Pure. */
export interface LatencySummary { readonly n: number; readonly p50: number | null; readonly p95: number | null; readonly mean: number | null; readonly min: number | null; readonly max: number | null }

export function percentile(sorted: readonly number[], p: number): number | null {
  if (!Number.isFinite(p) || p <= 0 || p > 100) throw new RangeError('p must be in (0, 100]');
  if (sorted.length === 0) return null;
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1]!;
}

export function summarize(samples: readonly number[]): LatencySummary {
  const sorted = [...samples].sort((a, b) => a - b);
  const n = sorted.length;
  return {
    n,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    mean: n === 0 ? null : sorted.reduce((s, v) => s + v, 0) / n,
    min: n === 0 ? null : sorted[0]!,
    max: n === 0 ? null : sorted[n - 1]!,
  };
}

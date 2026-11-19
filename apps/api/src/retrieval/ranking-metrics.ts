/**
 * Pure ranking metrics and Reciprocal Rank Fusion. No I/O.
 * `ranked` is an ordered list of document ids (best first). `relevant` maps id -> graded relevance (>= 0).
 */

export function recallAtK(ranked: readonly string[], relevant: ReadonlySet<string>, k: number): number {
  assertK(k);
  if (relevant.size === 0) return 0;
  const hits = ranked.slice(0, k).filter((id) => relevant.has(id)).length;
  return hits / relevant.size;
}

export function reciprocalRank(ranked: readonly string[], relevant: ReadonlySet<string>): number {
  const index = ranked.findIndex((id) => relevant.has(id));
  return index === -1 ? 0 : 1 / (index + 1);
}

/** Mean reciprocal rank over queries. Each query is { ranked, relevant }. */
export function meanReciprocalRank(queries: readonly { ranked: readonly string[]; relevant: ReadonlySet<string> }[]): number {
  if (queries.length === 0) return 0;
  return queries.reduce((sum, q) => sum + reciprocalRank(q.ranked, q.relevant), 0) / queries.length;
}

/** nDCG@K with graded gains: DCG = sum(gain_i / log2(i + 1)), normalised by the ideal ordering. */
export function ndcgAtK(ranked: readonly string[], grades: ReadonlyMap<string, number>, k: number): number {
  assertK(k);
  const dcg = ranked.slice(0, k).reduce((sum, id, i) => sum + (grades.get(id) ?? 0) / Math.log2(i + 2), 0);
  const ideal = [...grades.values()].sort((a, b) => b - a).slice(0, k);
  const idcg = ideal.reduce((sum, gain, i) => sum + gain / Math.log2(i + 2), 0);
  return idcg === 0 ? 0 : dcg / idcg;
}

/**
 * Reciprocal Rank Fusion: score(d) = sum over lists of 1 / (k0 + rank_in_list(d)), rank starting at 1.
 * Ties are broken by id so the output is deterministic.
 */
export function reciprocalRankFusion(lists: readonly (readonly string[])[], k0 = 60): string[] {
  if (!Number.isInteger(k0) || k0 < 0) throw new RangeError('k0 must be a non-negative integer');
  const scores = new Map<string, number>();
  for (const list of lists) {
    const seen = new Set<string>();
    list.forEach((id, index) => {
      if (seen.has(id)) return; // a duplicate within one list counts once
      seen.add(id);
      scores.set(id, (scores.get(id) ?? 0) + 1 / (k0 + index + 1));
    });
  }
  return [...scores.entries()]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([id]) => id);
}

function assertK(k: number): void {
  if (!Number.isInteger(k) || k < 1) throw new RangeError('k must be a positive integer');
}

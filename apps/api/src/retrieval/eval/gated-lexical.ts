/**
 * Gated lexical promotion over vector ranking. Pre-registered in docs/DEV-RETRIEVAL-CANDIDATE-GATED-LEXICAL.md: the parameters
 * below are fixed and must not be tuned on the measured set. Pure, no I/O. It only reorders; it never changes a score.
 */
export const GATE = { nearTieMargin: 0.02, lexicalFactor: 2, topN: 10 } as const;

export interface ScoredId { readonly id: string; readonly score: number }

/**
 * vector: all documents, best cosine first (ties on id). lexical: documents with a positive BM25 score, best first.
 * Returns the ranking. Only the top BM25 document can move, and only to rank one, and only when it is in the vector top ten,
 * within the near-tie margin of the top cosine, and BM25 is confident about it. Otherwise the vector order is returned.
 */
export function gatedLexicalRank(vector: readonly ScoredId[], lexical: readonly ScoredId[]): string[] {
  const vectorIds = vector.map((row) => row.id);
  const top = lexical[0];
  if (!top || top.score <= 0) return vectorIds;
  const second = lexical[1]?.score ?? 0;
  if (top.score < GATE.lexicalFactor * second) return vectorIds;

  const position = vector.findIndex((row) => row.id === top.id);
  if (position <= 0 || position >= GATE.topN) return vectorIds;
  const gap = vector[0]!.score - vector[position]!.score;
  if (gap > GATE.nearTieMargin) return vectorIds;

  return [top.id, ...vectorIds.slice(0, position), ...vectorIds.slice(position + 1)];
}

import { contentWords, limits, type Candidate, type EvidenceBundle, type ReviewReason, type ReviewResult } from './contracts.js';

/** Markers that make a retrieved excerpt unsafe to present as evidence. Such excerpts are filtered before review, and counted. */
export const UNSAFE_MARKERS = [/ignore (all |the )?(previous|prior|above) (instructions|messages)/i, /\bsystem prompt\b/i,
  /\bdisregard (the )?(rules|policy|instructions)\b/i, /\bexfiltrate\b/i, /<\/?(script|iframe)\b/i];
export const isUnsafeExcerpt = (text: string): boolean => UNSAFE_MARKERS.some((m) => m.test(text));

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').replace(/[.;:!?]+$/, '').trim();
const NEGATION = /\b(not|no longer|withdrawn|rejected|does not|cannot|must not)\b/i;

/**
 * Composes the candidate answer from the evidence: the first sentence of each of the top items, each cited to its item. Extractive by
 * construction, so every claim is a substring of its cited excerpt. A model-backed composer must meet the same reviewer checks.
 */
export function composeCandidate(bundle: EvidenceBundle): Candidate {
  const claims: Array<{ text: string; ref: string }> = [];
  for (const item of bundle.items.slice(0, limits.claimsPerAnswer)) {
    const first = item.excerpt.split(/(?<=[.!?])\s+/)[0].slice(0, limits.claimChars).trim();
    if (first.length > 0) claims.push({ text: first, ref: item.ref });
  }
  const answer = claims.map((c) => c.text).join(' ').slice(0, limits.answerChars);
  return { answer, claims };
}

/**
 * The reviewer's checks, in order: source resolution, claim support, contradiction, relevance to the question, safety and size. The
 * decision is 'reject' when a claim fails, 'insufficient_evidence' when nothing could be checked, and 'approve' otherwise.
 */
export function reviewCandidate(input: { question: string; answer: string; claims: ReadonlyArray<{ text: string; ref: string }>;
  evidence: ReadonlyArray<{ readonly ref: string; readonly excerpt: string }> }): ReviewResult {
  const reasons = new Set<ReviewReason>();
  const byRef = new Map(input.evidence.map((e) => [e.ref, e]));
  if (input.answer.length > limits.answerChars) reasons.add('answer_too_long');
  if (input.claims.length === 0) reasons.add('no_claims');
  let unsupported = 0;
  for (const claim of input.claims) {
    const item = byRef.get(claim.ref);
    if (!item) { reasons.add('unresolved_source'); unsupported += 1; continue; }
    if (!norm(item.excerpt).includes(norm(claim.text))) { reasons.add('unsupported_claim'); unsupported += 1; continue; }
    if (isUnsafeExcerpt(item.excerpt) || isUnsafeExcerpt(claim.text)) reasons.add('unsafe_content');
    // Contradiction: another item that shares at least three content words with the claim and states a negation.
    const claimWords = new Set(contentWords(claim.text));
    for (const other of input.evidence) {
      if (other.ref === claim.ref) continue;
      const shared = contentWords(other.excerpt).filter((w) => claimWords.has(w)).length;
      if (shared >= 3 && NEGATION.test(other.excerpt)) reasons.add('contradiction_detected');
    }
  }
  if (input.claims.length > 0) {
    const questionWords = new Set(contentWords(input.question));
    const relevant = contentWords(input.answer).some((w) => questionWords.has(w));
    if (!relevant) reasons.add('off_topic');
  }
  const checked = input.claims.length;
  const decision = reasons.size > 0 && checked > 0 ? 'reject' : checked === 0 ? 'insufficient_evidence' : 'approve';
  const sorted = [...reasons].sort() as ReviewReason[];
  return { decision, reasons: decision === 'approve' ? [] : sorted, claimsChecked: checked, unsupportedClaims: unsupported };
}

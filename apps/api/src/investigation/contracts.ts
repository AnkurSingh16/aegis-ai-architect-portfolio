/**
 * P8 typed contracts for the investigation workflow. Pure: no I/O. Every message the workflow exchanges is validated against these
 * shapes before it is used. Validation is structural. Authority is never read from these values: scopes, tenants, principals and
 * destinations are set by the orchestrator from verified state (see messaging/orchestration.ts).
 */

export const ACTIONS = {
  plan: 'investigation.plan',
  planResult: 'investigation.plan.result',
  retrieve: 'evidence.retrieve',
  retrieveResult: 'evidence.retrieve.result',
  review: 'answer.review',
  reviewResult: 'answer.review.result',
} as const;

export const REVIEW_CRITERIA = ['answers_question', 'claims_supported', 'sources_resolve', 'no_unsupported_claims', 'contradictions_checked'] as const;
export type ReviewCriterion = (typeof REVIEW_CRITERIA)[number];

export const REVIEW_REASONS = ['unresolved_source', 'unsupported_claim', 'contradiction_detected', 'off_topic', 'unsafe_content',
  'exceeds_evidence', 'answer_too_long', 'no_claims'] as const;
export type ReviewReason = (typeof REVIEW_REASONS)[number];

export const limits = Object.freeze({
  questionChars: 1000,
  queryChars: 256,
  topK: 3,
  excerptChars: 600,
  answerChars: 800,
  claimChars: 240,
  claimsPerAnswer: 4,
  evidenceItems: 3,
});

export interface TriagePlan {
  readonly intent: 'document_question' | 'out_of_scope';
  readonly retrieve: boolean;
  /** Words taken from the question. Every token must appear in the question (checked by validatePlan). */
  readonly query: string;
  readonly reviewerCriteria: readonly ReviewCriterion[];
}

export interface EvidenceItem {
  /** Stable reference: source identity, document version and chunk position. Resolved against the authorised bundle only. */
  readonly ref: string;
  readonly sourceIdentity: string;
  readonly version: number;
  readonly position: number;
  readonly title: string;
  readonly excerpt: string;
  readonly rank: number;
}

export interface EvidenceBundle {
  readonly status: 'found' | 'insufficient';
  readonly query: string;
  readonly items: readonly EvidenceItem[];
  /** Items removed because their content matched a prompt-injection marker. Counted, never shown as evidence. */
  readonly filteredUnsafe: number;
}

export interface Candidate {
  readonly answer: string;
  readonly claims: ReadonlyArray<{ readonly text: string; readonly ref: string }>;
}

export interface ReviewResult {
  readonly decision: 'approve' | 'insufficient_evidence' | 'reject';
  readonly reasons: readonly ReviewReason[];
  readonly claimsChecked: number;
  readonly unsupportedClaims: number;
}

const REF = /^[A-Za-z0-9._:-]{1,160}#[0-9]{1,6}@v[0-9]{1,6}$/;
export const isEvidenceRef = (value: unknown): value is string => typeof value === 'string' && REF.test(value);

export function evidenceRef(sourceIdentity: string, version: number, position: number): string {
  return `${sourceIdentity}#${position}@v${version}`;
}

const STOP = new Set(['the', 'and', 'for', 'with', 'what', 'which', 'when', 'where', 'who', 'does', 'did', 'are', 'was', 'were', 'have',
  'has', 'this', 'that', 'from', 'about', 'please', 'tell', 'me', 'show', 'give', 'you', 'our', 'their', 'there', 'into', 'any', 'all']);

/** Content words: lowercase letters and digits, at least four characters, not a stop word. */
export function contentWords(text: string): string[] {
  return [...new Set(text.toLowerCase().match(/[a-z0-9]+/g) ?? [])].filter((w) => w.length >= 4 && !STOP.has(w));
}

/** Validates the structure of a triage plan. Refuses anything outside the typed shape, and any query not drawn from the question. */
export function validatePlan(value: unknown, question: string):
  { readonly ok: true; readonly plan: TriagePlan } | { readonly ok: false; readonly reason: string } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return { ok: false, reason: 'invalid_plan' };
  const v = value as Record<string, unknown>;
  if (Object.keys(v).sort().join(',') !== 'intent,query,retrieve,reviewerCriteria') return { ok: false, reason: 'invalid_plan' };
  if (v.intent !== 'document_question' && v.intent !== 'out_of_scope') return { ok: false, reason: 'invalid_plan' };
  if (typeof v.retrieve !== 'boolean') return { ok: false, reason: 'invalid_plan' };
  if (typeof v.query !== 'string' || v.query.length > limits.queryChars) return { ok: false, reason: 'invalid_plan' };
  if (!Array.isArray(v.reviewerCriteria) || v.reviewerCriteria.some((c) => !(REVIEW_CRITERIA as readonly string[]).includes(c as string))) {
    return { ok: false, reason: 'invalid_plan' };
  }
  if (v.retrieve === true) {
    const questionWords = new Set(contentWords(question));
    const planWords = contentWords(v.query);
    if (planWords.length === 0 || planWords.some((w) => !questionWords.has(w))) return { ok: false, reason: 'invalid_plan' };
  }
  return { ok: true, plan: { intent: v.intent, retrieve: v.retrieve, query: v.query, reviewerCriteria: v.reviewerCriteria as ReviewCriterion[] } };
}

/** Validates an evidence bundle received from the retrieval agent. */
export function validateBundle(value: unknown):
  { readonly ok: true; readonly bundle: EvidenceBundle } | { readonly ok: false; readonly reason: string } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return { ok: false, reason: 'invalid_evidence' };
  const v = value as Record<string, unknown>;
  if (v.status !== 'found' && v.status !== 'insufficient') return { ok: false, reason: 'invalid_evidence' };
  if (!Array.isArray(v.items) || v.items.length > limits.evidenceItems) return { ok: false, reason: 'invalid_evidence' };
  if (typeof v.query !== 'string' || v.query.length > limits.queryChars) return { ok: false, reason: 'invalid_evidence' };
  if (!Number.isInteger(v.filteredUnsafe) || (v.filteredUnsafe as number) < 0) return { ok: false, reason: 'invalid_evidence' };
  const items: EvidenceItem[] = [];
  for (const raw of v.items) {
    const i = raw as Record<string, unknown>;
    if (typeof i !== 'object' || i === null || !isEvidenceRef(i.ref)) return { ok: false, reason: 'invalid_evidence' };
    if (typeof i.sourceIdentity !== 'string' || typeof i.title !== 'string' || typeof i.excerpt !== 'string') return { ok: false, reason: 'invalid_evidence' };
    if (i.excerpt.length === 0 || i.excerpt.length > limits.excerptChars || i.title.length > 160) return { ok: false, reason: 'invalid_evidence' };
    if (!Number.isInteger(i.version) || !Number.isInteger(i.position) || typeof i.rank !== 'number') return { ok: false, reason: 'invalid_evidence' };
    items.push({ ref: i.ref, sourceIdentity: i.sourceIdentity, version: i.version as number, position: i.position as number, title: i.title,
      excerpt: i.excerpt, rank: i.rank });
  }
  if (v.status === 'found' && items.length === 0) return { ok: false, reason: 'invalid_evidence' };
  if (v.status === 'insufficient' && items.length !== 0) return { ok: false, reason: 'invalid_evidence' };
  return { ok: true, bundle: { status: v.status, query: v.query, items, filteredUnsafe: v.filteredUnsafe as number } };
}

/** Validates a reviewer result. The orchestrator uses only this typed value. */
export function validateReview(value: unknown):
  { readonly ok: true; readonly review: ReviewResult } | { readonly ok: false; readonly reason: string } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return { ok: false, reason: 'invalid_review' };
  const v = value as Record<string, unknown>;
  if (v.decision !== 'approve' && v.decision !== 'insufficient_evidence' && v.decision !== 'reject') return { ok: false, reason: 'invalid_review' };
  if (!Array.isArray(v.reasons) || v.reasons.some((r) => !(REVIEW_REASONS as readonly string[]).includes(r as string))) return { ok: false, reason: 'invalid_review' };
  if (!Number.isInteger(v.claimsChecked) || !Number.isInteger(v.unsupportedClaims)) return { ok: false, reason: 'invalid_review' };
  if (v.decision === 'approve' && (v.reasons.length > 0 || (v.claimsChecked as number) < 1)) return { ok: false, reason: 'invalid_review' };
  return { ok: true, review: { decision: v.decision, reasons: v.reasons as ReviewReason[], claimsChecked: v.claimsChecked as number,
    unsupportedClaims: v.unsupportedClaims as number } };
}

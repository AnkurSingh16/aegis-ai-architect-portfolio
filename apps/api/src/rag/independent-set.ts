/**
 * Validator for an independently written labelled set (docs/C4-INDEPENDENT-EVAL-KIT/). It checks the shape, counts, mix and
 * uniqueness of a submitted set. It cannot check that the author was independent, and it does not write or judge questions.
 * Pure and deterministic.
 */

export type Role = 'calibration' | 'holdout';
export type AnswerableCategory = 'paraphrase' | 'direct';
export type UnanswerableCategory = 'near_miss' | 'unavailable_info' | 'restricted_source' | 'unrelated';

export interface IndependentItem {
  readonly id: string;
  readonly question: string;
  readonly kind: 'answerable' | 'unanswerable';
  readonly category: AnswerableCategory | UnanswerableCategory;
  /** Answerable items: the document that supports the answer, and the key points a complete answer must contain. */
  readonly supportingDocumentId?: string;
  readonly keyPoints?: readonly string[];
  /** Unanswerable items: why the documents cannot answer it. */
  readonly unanswerableReason?: string;
  readonly author: string;
  readonly writtenOn: string;
}

/** Minimum counts. The final holdout is 40 and 40 with the mix; calibration is 20 and 20 with the same categories. */
export const MINIMUMS: Record<Role, { answerable: number; unanswerable: number; paraphrase: number; nearMiss: number; perOtherCategory: number }> = {
  holdout: { answerable: 40, unanswerable: 40, paraphrase: 20, nearMiss: 10, perOtherCategory: 8 },
  calibration: { answerable: 20, unanswerable: 20, paraphrase: 10, nearMiss: 5, perOtherCategory: 4 },
};

const ANSWERABLE: readonly string[] = ['paraphrase', 'direct'];
const UNANSWERABLE: readonly string[] = ['near_miss', 'unavailable_info', 'restricted_source', 'unrelated'];
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

function normal(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

export function validateIndependentSet(items: readonly IndependentItem[], role: Role, existingQuestions: readonly string[] = []): string[] {
  const problems: string[] = [];
  const rule = MINIMUMS[role];
  const ids = new Set<string>();
  const texts = new Set<string>();
  const existing = new Set(existingQuestions.map(normal));

  for (const item of items) {
    const where = `item ${item.id || '(no id)'}`;
    if (!ID.test(item.id)) problems.push(`${where}: id must be 1 to 64 letters, digits, dots, dashes or underscores`);
    if (ids.has(item.id)) problems.push(`${where}: duplicate id`);
    ids.add(item.id);
    if (item.question.trim().length < 10) problems.push(`${where}: question is too short`);
    const key = normal(item.question);
    if (texts.has(key)) problems.push(`${where}: duplicate question text`);
    texts.add(key);
    if (existing.has(key)) problems.push(`${where}: question repeats an earlier set`);
    if (!item.author.trim()) problems.push(`${where}: author is required`);
    if (!DATE.test(item.writtenOn)) problems.push(`${where}: writtenOn must be YYYY-MM-DD`);

    if (item.kind === 'answerable') {
      if (!ANSWERABLE.includes(item.category)) problems.push(`${where}: answerable category must be paraphrase or direct`);
      if (!item.supportingDocumentId) problems.push(`${where}: answerable items need a supportingDocumentId`);
      if (!item.keyPoints || item.keyPoints.length === 0 || item.keyPoints.some((point) => point.trim().length === 0)) {
        problems.push(`${where}: answerable items need at least one non-empty key point`);
      }
      if (item.unanswerableReason !== undefined) problems.push(`${where}: answerable items must not give an unanswerable reason`);
    } else if (item.kind === 'unanswerable') {
      if (!UNANSWERABLE.includes(item.category)) problems.push(`${where}: unanswerable category is not recognised`);
      if (!item.unanswerableReason || item.unanswerableReason.trim().length === 0) problems.push(`${where}: unanswerable items need a reason`);
      if (item.supportingDocumentId !== undefined || item.keyPoints !== undefined) {
        problems.push(`${where}: unanswerable items must not have a supporting document or key points`);
      }
    } else {
      problems.push(`${where}: kind must be answerable or unanswerable`);
    }
  }

  const answerable = items.filter((item) => item.kind === 'answerable');
  const unanswerable = items.filter((item) => item.kind === 'unanswerable');
  const count = (list: readonly IndependentItem[], category: string) => list.filter((item) => item.category === category).length;

  if (answerable.length < rule.answerable) problems.push(`answerable count ${answerable.length} is below ${rule.answerable}`);
  if (unanswerable.length < rule.unanswerable) problems.push(`unanswerable count ${unanswerable.length} is below ${rule.unanswerable}`);
  if (count(answerable, 'paraphrase') < rule.paraphrase) problems.push(`paraphrase count is below ${rule.paraphrase}`);
  if (count(unanswerable, 'near_miss') < rule.nearMiss) problems.push(`near_miss count is below ${rule.nearMiss}`);
  for (const category of ['unavailable_info', 'restricted_source', 'unrelated']) {
    if (count(unanswerable, category) < rule.perOtherCategory) {
      problems.push(`${category} count ${count(unanswerable, category)} is below ${rule.perOtherCategory}`);
    }
  }
  return problems;
}

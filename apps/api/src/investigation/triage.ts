import { contentWords, limits, REVIEW_CRITERIA, type TriagePlan } from './contracts.js';

/**
 * Deterministic triage (the milestone's triage agent). It classifies the question and proposes a bounded plan. It proposes; it does not
 * authorise. The orchestrator validates the plan (validatePlan) and sets every scope and destination itself. A model-backed triage
 * replaces this function behind the same typed contract (see ai/investigation-provider.ts).
 */
// Words that describe the request rather than the subject. They are excluded from the retrieval query, which requires every term to match.
const GENERIC_WORDS = new Set(['synthetic', 'procedure', 'procedures', 'applies', 'apply', 'applicable', 'relevant', 'describe', 'describes', 'explain', 'about', 'guidance', 'support']);
const DOCUMENT_WORDS = new Set(['document', 'documents', 'policy', 'record', 'records', 'case', 'evidence', 'source', 'sources', 'review',
  'approval', 'claim', 'contract', 'report', 'file', 'files']);

export function planFromQuestion(question: string): TriagePlan {
  const words = contentWords(question);
  const documentIntent = words.some((w) => DOCUMENT_WORDS.has(w));
  if (!documentIntent || words.length === 0) {
    return { intent: 'out_of_scope', retrieve: false, query: '', reviewerCriteria: [] };
  }
  // Query: the first three content words of the question that are not document-type words, in order. Every token is taken from the
  // question, so the reviewer and the orchestrator can check that the plan did not introduce a term of its own.
  const tokens: string[] = [];
  for (const token of question.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
    if (token.length >= 4 && contentWords(token).length === 1 && !DOCUMENT_WORDS.has(token) && !GENERIC_WORDS.has(token) && !tokens.includes(token)) tokens.push(token);
    if (tokens.length === 3) break;
  }
  const query = tokens.join(' ').slice(0, limits.queryChars);
  return { intent: 'document_question', retrieve: query.length > 0, query, reviewerCriteria: [...REVIEW_CRITERIA] };
}

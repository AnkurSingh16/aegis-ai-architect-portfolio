import { describe, expect, it } from 'vitest';
import { planFromQuestion } from './triage.js';

// The deterministic planner is a keyword classifier, not a language model. It retrieves only when the question contains a document-type
// word. These cases pin that behaviour so it cannot change silently. A paraphrase that does not contain one of those words is refused as
// out of scope. That is a documented capability limit, not a security control: refusing is the safe outcome. Broadening the intent
// vocabulary requires a new case here first. Natural-language paraphrase evaluation belongs to the model-backed planner.

describe('deterministic triage: document intent', () => {
  it('plans retrieval for a question with a document-type word and a subject', () => {
    expect(planFromQuestion('Which synthetic document describes the sign-in interruption procedure for a demonstration account?')).toMatchObject({
      intent: 'document_question', retrieve: true });
  });

  it('documented limit: a paraphrase with no document-type word is out of scope and does not retrieve', () => {
    // "recorded" is not "record"; the classifier matches exact words only.
    expect(planFromQuestion('For a synthetic sign-in interruption, what should be recorded and checked first?')).toEqual({
      intent: 'out_of_scope', retrieve: false, query: '', reviewerCriteria: [] });
  });

  it('a question with only generic words plans no retrieval even when a document word is present', () => {
    expect(planFromQuestion('Which synthetic document applies?').retrieve).toBe(false);
  });

  it('never produces a query containing a document-type word or a generic word', () => {
    const plan = planFromQuestion('Which synthetic policy document describes the account recovery procedure for a contract?');
    expect(plan.query.split(' ').some((term) => ['document', 'policy', 'contract', 'synthetic', 'procedure'].includes(term))).toBe(false);
  });
});

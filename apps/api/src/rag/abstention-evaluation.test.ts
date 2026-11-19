import { describe, expect, it } from 'vitest';
import type { LabelledCase } from './abstention-cases.js';
import { scoreAbstentionCases } from './abstention-evaluation.js';

const cases: LabelledCase[] = [
  { id: 'a1', question: 'q1', expected: { kind: 'answer', sourceId: 'DOC-A' } },
  { id: 'a2', question: 'q2', expected: { kind: 'answer', sourceId: 'DOC-B' } },
  { id: 'a3', question: 'q3', expected: { kind: 'answer', sourceId: 'DOC-C' } },
  { id: 'u1', question: 'q4', expected: { kind: 'abstain' } },
  { id: 'u2', question: 'q5', expected: { kind: 'abstain' } },
];

describe('scoreAbstentionCases', () => {
  it('counts each kind of decision once and computes the rates', () => {
    const report = scoreAbstentionCases(cases, [
      { status: 'answered', citations: ['DOC-A'] },   // correct
      { status: 'answered', citations: ['DOC-X'] },   // wrong source
      { status: 'abstained' },                        // false abstention
      { status: 'abstained' },                        // true abstention
      { status: 'answered', citations: ['DOC-A'] },   // false answer
    ]);
    expect(report).toMatchObject({
      total: 5, answerable: 3, unanswerable: 2, correctAnswers: 1, wrongSourceAnswers: 1,
      falseAbstentions: 1, falseAnswers: 1, trueAbstentions: 1,
      answerRecall: 1 / 3, falseAnswerRate: 1 / 2, abstentionPrecision: 1 / 2,
    });
  });

  it('treats an answer with no citation as a wrong-source answer, not a correct one', () => {
    const report = scoreAbstentionCases([cases[0]!], [{ status: 'answered', citations: [] }]);
    expect(report).toMatchObject({ correctAnswers: 0, wrongSourceAnswers: 1 });
  });

  it('requires every citation to name the expected source', () => {
    const report = scoreAbstentionCases([cases[0]!], [{ status: 'answered', citations: ['DOC-A', 'DOC-X'] }]);
    expect(report).toMatchObject({ correctAnswers: 0, wrongSourceAnswers: 1 });
  });

  it('returns null rates instead of dividing by zero', () => {
    const report = scoreAbstentionCases([cases[0]!], [{ status: 'answered', citations: ['DOC-A'] }]);
    expect(report).toMatchObject({ falseAnswerRate: null, abstentionPrecision: null, answerRecall: 1 });
  });

  it('rejects a mismatched number of outcomes', () => {
    expect(() => scoreAbstentionCases(cases, [{ status: 'abstained' }])).toThrow(RangeError);
  });
});

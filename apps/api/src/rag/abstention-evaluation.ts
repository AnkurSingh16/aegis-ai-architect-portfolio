import type { LabelledCase } from './abstention-cases.js';

/**
 * Scores labelled cases against the loop's outcomes. Pure: it does not retrieve, generate or call a model.
 * It measures the control loop's answer and abstention decisions, not the quality of any generated text.
 */
export type CaseOutcome =
  | { readonly status: 'answered'; readonly citations: readonly string[] }
  | { readonly status: 'abstained' };

export interface AbstentionReport {
  readonly total: number;
  readonly answerable: number;
  readonly unanswerable: number;
  /** Answered, and every citation names the expected source. */
  readonly correctAnswers: number;
  /** Answered, but a citation names another source or none. */
  readonly wrongSourceAnswers: number;
  /** Abstained on an answerable case. */
  readonly falseAbstentions: number;
  /** Answered an unanswerable case. */
  readonly falseAnswers: number;
  /** Abstained on an unanswerable case. */
  readonly trueAbstentions: number;
  /** correctAnswers / answerable, or null when there are no answerable cases. */
  readonly answerRecall: number | null;
  /** falseAnswers / unanswerable, or null when there are no unanswerable cases. */
  readonly falseAnswerRate: number | null;
  /** trueAbstentions / all abstentions, or null when the loop never abstained. */
  readonly abstentionPrecision: number | null;
}

const ratio = (numerator: number, denominator: number): number | null => (denominator === 0 ? null : numerator / denominator);

export function scoreAbstentionCases(cases: readonly LabelledCase[], outcomes: readonly CaseOutcome[]): AbstentionReport {
  if (cases.length !== outcomes.length) throw new RangeError('one outcome is required for each case');
  let correctAnswers = 0, wrongSourceAnswers = 0, falseAbstentions = 0, falseAnswers = 0, trueAbstentions = 0;
  let answerable = 0, unanswerable = 0;
  cases.forEach((labelled, index) => {
    const outcome = outcomes[index]!;
    const expected = labelled.expected;
    if (expected.kind === 'answer') {
      answerable += 1;
      if (outcome.status === 'abstained') falseAbstentions += 1;
      else if (outcome.citations.length > 0 && outcome.citations.every((id) => id === expected.sourceId)) correctAnswers += 1;
      else wrongSourceAnswers += 1;
    } else {
      unanswerable += 1;
      if (outcome.status === 'answered') falseAnswers += 1;
      else trueAbstentions += 1;
    }
  });
  const abstentions = falseAbstentions + trueAbstentions;
  return {
    total: cases.length, answerable, unanswerable, correctAnswers, wrongSourceAnswers, falseAbstentions, falseAnswers, trueAbstentions,
    answerRecall: ratio(correctAnswers, answerable),
    falseAnswerRate: ratio(falseAnswers, unanswerable),
    abstentionPrecision: ratio(trueAbstentions, abstentions),
  };
}

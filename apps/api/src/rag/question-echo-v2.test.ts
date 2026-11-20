import { describe, expect, it } from 'vitest';
import { isQuestionEchoV2, QUESTION_ECHO_CHECK_V2, questionEchoV2 } from './question-echo-v2.js';

// Development fixtures. These are regression checks of the rule, written by the pipeline, and are NOT evaluation evidence.
// The seven v8 cases are included only because the owner's review labelled them. They are not a new measurement.

describe('question echo check v2: identity', () => {
  it('is versioned as echo-v2', () => {
    expect(QUESTION_ECHO_CHECK_V2).toBe('echo-v2');
  });
});

describe('v8 owner-reviewed cases (regression only)', () => {
  it('flags the two answers that only repeat the question', () => {
    expect(questionEchoV2(
      'Should I check whether a sign-in interruption is limited to one synthetic account before rating it?',
      '[SYNTHETIC-NORTH-LOGIN-INCIDENT] Should I check whether a sign-in interruption is limited to one synthetic account before rating it? [SYNTHETIC-NORTH-LOGIN-INCIDENT]',
    )).toEqual({ echo: true, reason: 'question_only' });
    expect(isQuestionEchoV2(
      'Is the name written in a recovery case description sufficient evidence of identity?',
      'Is the name written in a recovery case description sufficient evidence of identity? [SYNTHETIC-NORTH-ACCOUNT-RECOVERY]',
    )).toBe(true);
  });

  it('does not flag the five responsive or partial answers', () => {
    expect(isQuestionEchoV2(
      'When a verification challenge keeps failing, what should I confirm about the test factor?',
      'When a synthetic user reports a multi-factor challenge problem, confirm that the expected test factor is available. Sources: [SYNTHETIC-NORTH-MFA-GUIDANCE]',
    )).toBe(false);
    expect(isQuestionEchoV2(
      'Can a support worker turn off a factor to get past a challenge?',
      'A support worker cannot turn off a factor to get past a challenge. Sources: [SYNTHETIC-NORTH-MFA-GUIDANCE]',
    )).toBe(false);
    expect(isQuestionEchoV2(
      'Which status page may a support agent look at for the identity provider?',
      'A support agent may review the approved local identity-provider status page. Sources: [SYNTHETIC-NORTH-MFA-GUIDANCE]',
    )).toBe(false);
    expect(isQuestionEchoV2(
      'What must happen before anything is altered on an account that is awaiting recovery?',
      'For a synthetic account recovery request, verify the account through the established human support process before making any change.',
    )).toBe(false);
    expect(isQuestionEchoV2(
      'Does a healthy loopback response mean the tenant request is allowed?',
      'A healthy loopback response does not mean the tenant request is allowed. Sources: [SYNTHETIC-NORTH-NETWORK-DIAGNOSTICS]',
    )).toBe(false);
  });
});

describe('valid short answers are never flagged', () => {
  const question = 'Can I approve a refund myself after a billing review?';
  it.each(['Yes.', 'No.', 'No [SYNTHETIC-SOUTH-BILLING-DISCREPANCY]', 'Not without approval. Sources: [SYNTHETIC-SOUTH-BILLING-DISCREPANCY]'])(
    'keeps %s', (answer) => { expect(isQuestionEchoV2(question, answer)).toBe(false); });

  it('keeps a short yes/no answer that adds a supported reason', () => {
    expect(isQuestionEchoV2(question, 'No, a billing review needs a second approver.')).toBe(false);
  });
});

describe('restatement followed by a real answer is not an echo', () => {
  it('does not flag the question, then a supported answer', () => {
    expect(isQuestionEchoV2(
      'Is the name written in a recovery case description sufficient evidence of identity?',
      'Is the name written in a recovery case description sufficient evidence of identity? No. Human verification is required. Sources: [SYNTHETIC-NORTH-ACCOUNT-RECOVERY]',
    )).toBe(false);
  });

  it('does not flag a restated statement followed by a responsive sentence', () => {
    expect(isQuestionEchoV2(
      'Should I check whether a sign-in interruption is limited to one account?',
      'Check whether the interruption is limited to one account. Record the time window first. [SYNTHETIC-NORTH-LOGIN-INCIDENT]',
    )).toBe(false);
  });
});

describe('paraphrased and punctuation variants', () => {
  it('flags a paraphrased question-only answer, because it is a question and nothing else', () => {
    expect(questionEchoV2(
      'Is the name written in a recovery case description sufficient evidence of identity?',
      'Is the name in a recovery case description enough to prove who the requester is? [SYNTHETIC-NORTH-ACCOUNT-RECOVERY]',
    )).toEqual({ echo: true, reason: 'question_only' });
  });

  it('flags a restatement that changes case, punctuation and plural/tense, with no new words', () => {
    expect(questionEchoV2('how do i reset my ACCOUNT PASSWORD?', 'How do I reset my account passwords!!')).toEqual({ echo: true, reason: 'restated' });
    expect(questionEchoV2('how do i reset my account password?', 'How do I reset my account password')).toEqual({ echo: true, reason: 'restated' });
  });

  it('does not flag a two-word restatement, which is below the three-word minimum (documented conservative limit)', () => {
    expect(questionEchoV2('how do i reset my password?', 'How do I reset my password!!')).toEqual({ echo: false, reason: 'answer_present' });
  });

  it('keeps an answer that paraphrases with new words (documented limit: not flagged)', () => {
    expect(isQuestionEchoV2(
      'Is the name written in a recovery case description sufficient evidence of identity?',
      'The name in a case description is not enough to prove identity.',
    )).toBe(false);
  });
});

describe('negation is never matched away', () => {
  it('does not flag a statement that negates the question', () => {
    expect(isQuestionEchoV2(
      'Does a healthy response mean the request is allowed?',
      'A healthy response does not mean the request is allowed.',
    )).toBe(false);
  });
});

describe('empty and citation-only text', () => {
  it('reports no_text for an answer with only citations, and is not an echo', () => {
    expect(questionEchoV2('Is that enough?', 'Sources: [SYNTHETIC-NORTH-ACCOUNT-RECOVERY]')).toEqual({ echo: false, reason: 'no_text' });
    expect(questionEchoV2('Is that enough?', '   ')).toEqual({ echo: false, reason: 'no_text' });
  });
});

describe('known false positive (documented, not claimed as correct)', () => {
  it('flags a real instruction whose words all come from the question', () => {
    expect(isQuestionEchoV2('Verify the account before any change?', 'Verify the account before any change. [SYNTHETIC-NORTH-ACCOUNT-RECOVERY]')).toBe(true);
  });
});

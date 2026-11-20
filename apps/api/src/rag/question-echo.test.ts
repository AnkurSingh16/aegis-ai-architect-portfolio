import { describe, expect, it } from 'vitest';
import { isQuestionEcho, QUESTION_ECHO_CHECK } from './question-echo.js';

describe('question echo check v1', () => {
  it('is versioned', () => {
    expect(QUESTION_ECHO_CHECK).toBe('echo-v1');
  });

  it('flags the two v8 answers that only repeat the question', () => {
    expect(isQuestionEcho(
      'Should I check whether a sign-in interruption is limited to one synthetic account before rating it?',
      '[SYNTHETIC-NORTH-LOGIN-INCIDENT] Should I check whether a sign-in interruption is limited to one synthetic account before rating it? [SYNTHETIC-NORTH-LOGIN-INCIDENT]',
    )).toBe(true);
    expect(isQuestionEcho(
      'Is the name written in a recovery case description sufficient evidence of identity?',
      'Is the name written in a recovery case description sufficient evidence of identity? [SYNTHETIC-NORTH-ACCOUNT-RECOVERY]',
    )).toBe(true);
  });

  it('does not flag a short supported answer such as No', () => {
    expect(isQuestionEcho(
      'Is the name written in a recovery case description sufficient evidence of identity?',
      'No. Sources: [SYNTHETIC-NORTH-ACCOUNT-RECOVERY]',
    )).toBe(false);
    expect(isQuestionEcho('Is that enough?', 'No [SYNTHETIC-NORTH-ACCOUNT-RECOVERY]')).toBe(false);
  });

  it('does not flag a real answer that adds words the question does not contain', () => {
    expect(isQuestionEcho(
      'Is the name written in a recovery case description sufficient evidence of identity?',
      'No. Human verification through the established support process is required. Sources: [SYNTHETIC-NORTH-ACCOUNT-RECOVERY]',
    )).toBe(false);
  });

  it('does not flag an accurate partial answer that uses source wording', () => {
    expect(isQuestionEcho(
      'Which status page may a support agent look at for the identity provider?',
      'A support agent may review the approved local identity-provider status page. Sources: [SYNTHETIC-NORTH-MFA-GUIDANCE]',
    )).toBe(false);
  });

  it('treats an answer with no words outside citations as not an echo (the answer-text check handles it)', () => {
    expect(isQuestionEcho('Is that enough?', 'Sources: [SYNTHETIC-NORTH-ACCOUNT-RECOVERY]')).toBe(false);
  });

  it('ignores case and punctuation differences', () => {
    expect(isQuestionEcho('how do i reset my PASSWORD?', 'How do I reset my password!!')).toBe(true);
  });

  describe('valid short answers are never flagged', () => {
    const question = 'Can I approve a refund myself after a billing review?';
    it.each(['Yes.', 'No.', 'No [SYNTHETIC-SOUTH-BILLING-DISCREPANCY]', 'Not without approval. Sources: [SYNTHETIC-SOUTH-BILLING-DISCREPANCY]'])(
      'keeps %s', (answer) => { expect(isQuestionEcho(question, answer)).toBe(false); });
  });

  describe('a restatement followed by a real answer is not an echo', () => {
    it('does not flag the question, then a supported answer', () => {
      expect(isQuestionEcho(
        'Is the name written in a recovery case description sufficient evidence of identity?',
        'Is the name written in a recovery case description sufficient evidence of identity? No. Human verification is required. Sources: [SYNTHETIC-NORTH-ACCOUNT-RECOVERY]',
      )).toBe(false);
    });

    it('does not flag a question with an answer that adds one new content word', () => {
      expect(isQuestionEcho(
        'Should I check whether a sign-in interruption is limited to one account?',
        'Should I check whether a sign-in interruption is limited to one account? Yes, first. [SYNTHETIC-NORTH-LOGIN-INCIDENT]',
      )).toBe(false);
    });
  });

  describe('known limits of v1 (documented, not claimed as caught)', () => {
    it('misses a paraphrased echo that uses new words, so v1 does not catch it', () => {
      expect(isQuestionEcho(
        'Is the name written in a recovery case description sufficient evidence of identity?',
        'Is the name in a recovery case description enough to prove who the requester is? [SYNTHETIC-NORTH-ACCOUNT-RECOVERY]',
      )).toBe(false);
    });

    it('flags a real answer whose words all come from the question (known false positive)', () => {
      expect(isQuestionEcho(
        'Verify the account before any change?',
        'Verify the account before any change. [SYNTHETIC-NORTH-ACCOUNT-RECOVERY]',
      )).toBe(true);
    });
  });
});

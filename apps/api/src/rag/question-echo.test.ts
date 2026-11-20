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
});

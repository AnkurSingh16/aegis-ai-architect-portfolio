import { describe, expect, it } from 'vitest';
import { answerDemoQuestion } from './demo.js';

describe('synthetic demo', () => {
  it('uses a login incident illustration without claiming to call AI', () => {
    const answer = answerDemoQuestion('401 login');
    expect(answer.answer).toContain('synthetic incident logs');
    expect(answer.warning).toContain('Not a real AI answer');
  });
  it('uses a general illustration for other questions', () => {
    expect(answerDemoQuestion('What is RAG?').answer).toContain('future retrieval service');
  });
});

import { describe, expect, it, vi } from 'vitest';
import { answerWithSelfCorrection, type Evidence, type SelfCorrectionDeps, type SelfCorrectionPolicy } from './self-correcting-answer.js';

const good: Evidence[] = [
  { sourceId: 'doc-a', text: 'Reset steps are in the help article.', score: 0.9 },
  { sourceId: 'doc-b', text: 'Escalation path.', score: 0.6 },
];
const policy: SelfCorrectionPolicy = { maxRounds: 3, minScore: 0.3, forbiddenSubstrings: ['SENTINEL-XYZ'] };

function deps(overrides: Partial<SelfCorrectionDeps> = {}): SelfCorrectionDeps {
  return {
    retrieve: vi.fn(async () => good),
    generate: vi.fn(async () => 'Reset from the help article [doc-a].'),
    reformulate: vi.fn(async () => 'alternative query'),
    ...overrides,
  };
}

describe('answerWithSelfCorrection', () => {
  it('answers in one round when the answer is cited to retrieved evidence', async () => {
    const d = deps();
    const result = await answerWithSelfCorrection('how do I reset', d, policy);
    expect(result).toMatchObject({ status: 'answered', citations: ['doc-a'], rounds: 1, problemHistory: [] });
    expect(d.reformulate).not.toHaveBeenCalled();
  });

  it('abstains without generating when no evidence clears the score floor', async () => {
    const d = deps({ retrieve: vi.fn(async () => [{ sourceId: 'doc-a', text: 'x', score: 0.1 }]) });
    const result = await answerWithSelfCorrection('question', d, policy);
    expect(result).toMatchObject({ status: 'abstained', reason: 'insufficient_evidence', rounds: 1 });
    expect(d.generate).not.toHaveBeenCalled();
  });

  it('corrects an unknown citation on the next round using only the problem name as feedback', async () => {
    const generate = vi.fn()
      .mockResolvedValueOnce('Use the admin page [doc-zzz].')
      .mockResolvedValueOnce('Use the admin page [doc-b].');
    const d = deps({ generate });
    const result = await answerWithSelfCorrection('question', d, policy);
    expect(result).toMatchObject({ status: 'answered', citations: ['doc-b'], rounds: 2 });
    expect(result.status === 'answered' && result.problemHistory).toEqual([['unknown_citation']]);
    expect(generate.mock.calls[1]?.[0]).toMatchObject({ feedback: ['unknown_citation'], query: 'alternative query' });
  });

  it('treats a forbidden substring as a failure and never returns the text', async () => {
    const generate = vi.fn()
      .mockResolvedValueOnce('The answer is SENTINEL-XYZ [doc-a].')
      .mockResolvedValueOnce('The answer is clear [doc-a].');
    const result = await answerWithSelfCorrection('question', deps({ generate }), policy);
    expect(result).toMatchObject({ status: 'answered', answer: 'The answer is clear [doc-a].', rounds: 2 });
    expect(result.status === 'answered' && result.problemHistory).toEqual([['forbidden_substring']]);
  });

  it('requires at least one citation', async () => {
    const d = deps({ generate: vi.fn(async () => 'No citation here.') });
    const result = await answerWithSelfCorrection('question', d, { ...policy, maxRounds: 1 });
    expect(result).toMatchObject({ status: 'abstained', reason: 'guard_failed', rounds: 1 });
    expect(result.problemHistory).toEqual([['no_citation']]);
  });

  it('stops at the round bound and abstains, without exceeding maxRounds', async () => {
    const d = deps({ generate: vi.fn(async () => 'Bad [unknown-id].') });
    const result = await answerWithSelfCorrection('question', d, { ...policy, maxRounds: 2 });
    expect(result).toMatchObject({ status: 'abstained', reason: 'guard_failed', rounds: 2 });
    expect(d.generate).toHaveBeenCalledTimes(2);
    expect(d.retrieve).toHaveBeenCalledTimes(2);
  });

  it('abstains when no reformulation is available after a failed round', async () => {
    const d = deps({ generate: vi.fn(async () => 'Bad [unknown-id].'), reformulate: vi.fn(async () => null) });
    const result = await answerWithSelfCorrection('question', d, policy);
    expect(result).toMatchObject({ status: 'abstained', reason: 'reformulation_unavailable', rounds: 1 });
  });

  it('abstains when a reformulation is empty or oversized', async () => {
    const empty = deps({ generate: vi.fn(async () => 'Bad [x].'), reformulate: vi.fn(async () => '   ') });
    expect(await answerWithSelfCorrection('q', empty, policy)).toMatchObject({ reason: 'reformulation_unavailable' });
    const long = deps({ generate: vi.fn(async () => 'Bad [x].'), reformulate: vi.fn(async () => 'a'.repeat(501)) });
    expect(await answerWithSelfCorrection('q', long, policy)).toMatchObject({ reason: 'reformulation_unavailable' });
  });

  it('treats a citation-only answer as a failure when answer text is required', async () => {
    const generate = vi.fn()
      .mockResolvedValueOnce('Sources: [doc-a]')
      .mockResolvedValueOnce('Reset from the help article [doc-a].');
    const result = await answerWithSelfCorrection('question', deps({ generate }), { ...policy, requireAnswerText: true });
    expect(result).toMatchObject({ status: 'answered', answer: 'Reset from the help article [doc-a].', rounds: 2 });
    expect(result.status === 'answered' && result.problemHistory).toEqual([['no_answer_text']]);
  });

  it('abstains when every round is citation-only and answer text is required', async () => {
    const d = deps({ generate: vi.fn(async () => 'Sources: [doc-a]') });
    const result = await answerWithSelfCorrection('question', d, { ...policy, maxRounds: 1, requireAnswerText: true });
    expect(result).toMatchObject({ status: 'abstained', reason: 'guard_failed', rounds: 1 });
    expect(result.problemHistory).toEqual([['no_answer_text']]);
  });

  it('keeps citation-only answers when answer text is not required (recorded runs unchanged)', async () => {
    const d = deps({ generate: vi.fn(async () => 'Sources: [doc-a]') });
    const result = await answerWithSelfCorrection('question', d, { ...policy, maxRounds: 1 });
    expect(result).toMatchObject({ status: 'answered', citations: ['doc-a'], rounds: 1 });
  });

  it('rejects a round bound outside 1 to 3 and an empty question', async () => {
    await expect(answerWithSelfCorrection('q', deps(), { ...policy, maxRounds: 0 })).rejects.toThrow(RangeError);
    await expect(answerWithSelfCorrection('q', deps(), { ...policy, maxRounds: 4 })).rejects.toThrow(RangeError);
    await expect(answerWithSelfCorrection('  ', deps(), policy)).rejects.toThrow(RangeError);
  });
});

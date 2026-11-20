import { describe, expect, it, vi } from 'vitest';
import { answerWithSelfCorrection, type Evidence } from './self-correcting-answer.js';

const strong: Evidence[] = [{ sourceId: 'SYNTHETIC-NORTH-MFA-GUIDANCE', text: 'Confirm the test factor.', score: 0.8 }];
const weak: Evidence[] = [{ sourceId: 'SYNTHETIC-NORTH-MFA-GUIDANCE', text: 'Confirm the test factor.', score: 0.5 }];

function deps(retrieve: (query: string) => Promise<Evidence[]>, reformulate: (input: unknown) => Promise<string | null>) {
  return {
    retrieve: vi.fn(retrieve),
    generate: vi.fn(async ({ evidence }: { evidence: readonly Evidence[] }) => `Confirm it [${evidence[0]!.sourceId}].`),
    reformulate: vi.fn(reformulate),
  };
}

const base = { maxRounds: 2, minScore: 0.7, forbiddenSubstrings: ['SENTINEL-XYZ'] };

describe('retryOnInsufficientEvidence', () => {
  it('is off by default: no reformulation, and abstains after the first round', async () => {
    const d = deps(async () => weak, async () => 'another query');
    const result = await answerWithSelfCorrection('a question', d, base);
    expect(result).toMatchObject({ status: 'abstained', reason: 'insufficient_evidence', rounds: 1 });
    expect(d.reformulate).not.toHaveBeenCalled();
  });

  it('when on, retries with the reworded query and answers if the new query finds usable evidence', async () => {
    const d = deps(async (query) => (query === 'reworded query' ? strong : weak), async () => 'reworded query');
    const result = await answerWithSelfCorrection('a question', d, { ...base, retryOnInsufficientEvidence: true });
    expect(result).toMatchObject({ status: 'answered', citations: ['SYNTHETIC-NORTH-MFA-GUIDANCE'], rounds: 2 });
    expect(d.retrieve.mock.calls.map((call) => call[0])).toEqual(['a question', 'reworded query']);
    expect(d.reformulate).toHaveBeenCalledTimes(1);
    expect(d.reformulate.mock.calls[0]![0]).toMatchObject({ feedback: ['insufficient_evidence'] });
  });

  it('abstains with the same reason when reformulation returns null', async () => {
    const d = deps(async () => weak, async () => null);
    const result = await answerWithSelfCorrection('a question', d, { ...base, retryOnInsufficientEvidence: true });
    expect(result).toMatchObject({ status: 'abstained', reason: 'insufficient_evidence', rounds: 1 });
    expect(d.generate).not.toHaveBeenCalled();
  });

  it('does not reformulate on the last round', async () => {
    const d = deps(async () => weak, async () => 'reworded query');
    const result = await answerWithSelfCorrection('a question', d, { ...base, maxRounds: 1, retryOnInsufficientEvidence: true });
    expect(result).toMatchObject({ status: 'abstained', reason: 'insufficient_evidence', rounds: 1 });
    expect(d.reformulate).not.toHaveBeenCalled();
  });

  it('abstains after the last round when the reworded query also finds nothing usable', async () => {
    const d = deps(async () => weak, async () => 'reworded query');
    const result = await answerWithSelfCorrection('a question', d, { ...base, retryOnInsufficientEvidence: true });
    expect(result).toMatchObject({ status: 'abstained', reason: 'insufficient_evidence', rounds: 2 });
    expect(d.generate).not.toHaveBeenCalled();
  });
});

import { describe, expect, it } from 'vitest';
import {
  buildReport, INDEPENDENT_RUNNER_VERSION, type ItemRecord, type LockedSet, loadLockedSet, runLockedSet, type RunnerDeps,
  scoreRecords, sha256Hex, stableJson, toLabelledCases, type HumanRow,
} from './independent-runner.js';
import type { IndependentItem } from './independent-set.js';
import type { Evidence } from './self-correcting-answer.js';

// Mocked providers and generated placeholder items only. No model, no network, no evaluation question is written here.
const policy = { maxRounds: 1, minScore: 0.7, forbiddenSubstrings: [], requireAnswerText: true };
const FLOOR = 0.7;

function holdoutFile(): string {
  const items: IndependentItem[] = [];
  for (let i = 1; i <= 40; i += 1) {
    items.push({ id: `A${String(i).padStart(3, '0')}`, question: `placeholder answerable question ${i} for the loader test`, kind: 'answerable',
      category: i <= 20 ? 'paraphrase' : 'direct', supportingDocumentId: 'IND-ACCESS-01', keyPoints: ['a point'], author: 'author-x', writtenOn: '2026-12-01' });
  }
  const groups: [string, number][] = [['near_miss', 10], ['unavailable_info', 10], ['restricted_source', 10], ['unrelated', 10]];
  let n = 0;
  for (const [category, count] of groups) {
    for (let i = 0; i < count; i += 1) {
      n += 1;
      items.push({ id: `U${String(n).padStart(3, '0')}`, question: `placeholder unanswerable question ${n} for the loader test`, kind: 'unanswerable',
        category: category as IndependentItem['category'], unanswerableReason: 'not covered', author: 'author-x', writtenOn: '2026-12-01' });
    }
  }
  return JSON.stringify({ corpusVersion: 'ind-corpus-v1', role: 'holdout', items }, null, 2);
}

const small: IndependentItem[] = [
  { id: 'A1', question: 'how do refunds work alpha', kind: 'answerable', category: 'direct', supportingDocumentId: 'DOC-A', keyPoints: ['k'], author: 'x', writtenOn: '2026-12-01' },
  { id: 'A2', question: 'how do exports work beta', kind: 'answerable', category: 'paraphrase', supportingDocumentId: 'DOC-A', keyPoints: ['k'], author: 'x', writtenOn: '2026-12-01' },
  { id: 'U1', question: 'what is the moon made of delta', kind: 'unanswerable', category: 'unrelated', unanswerableReason: 'r', author: 'x', writtenOn: '2026-12-01' },
  { id: 'U2', question: 'are exports allowed epsilon', kind: 'unanswerable', category: 'near_miss', unanswerableReason: 'r', author: 'x', writtenOn: '2026-12-01' },
  { id: 'U3', question: 'what is the price gamma', kind: 'unanswerable', category: 'restricted_source', unanswerableReason: 'r', author: 'x', writtenOn: '2026-12-01' },
];

function lockedSmall(): LockedSet {
  return { corpusVersion: 'ind-corpus-v1', role: 'holdout', items: small, setSha256: 'f'.repeat(64) };
}

/** Mocked providers. Tags in the question choose the behaviour; nothing here calls a model. */
function mockDeps(): RunnerDeps {
  return {
    retrieve: async (query: string): Promise<Evidence[]> => {
      if (query.includes('beta')) return [{ sourceId: 'DOC-B', text: 'b', score: 0.9 }, { sourceId: 'DOC-A', text: 'a', score: 0.8 }];
      if (query.includes('alpha') || query.includes('epsilon') || query.includes('gamma')) return [{ sourceId: 'DOC-A', text: 'a', score: 0.9 }];
      return [{ sourceId: 'DOC-B', text: 'b', score: 0.3 }];
    },
    generate: async ({ question }) => {
      if (question.includes('alpha')) return 'Refunds are accepted within thirty days of purchase. Sources: [DOC-A]';
      if (question.includes('beta')) return 'Exports need identity checks first. [DOC-B]';
      if (question.includes('epsilon')) return 'Exports are allowed in every case. [DOC-A]';
      throw new TypeError('provider unavailable');
    },
    reformulate: async () => null,
  };
}

describe('loadLockedSet', () => {
  it('accepts a file whose hash matches the lock and that passes the validator', () => {
    const text = holdoutFile();
    const set = loadLockedSet(text, sha256Hex(text), 'holdout');
    expect(set.items).toHaveLength(80);
    expect(set.corpusVersion).toBe('ind-corpus-v1');
    expect(set.setSha256).toBe(sha256Hex(text));
  });

  it('rejects a single changed byte, because the hash no longer matches', () => {
    const text = holdoutFile();
    expect(() => loadLockedSet(text.replace('placeholder answerable question 1 ', 'placeholder answerable question 1  '), sha256Hex(text), 'holdout'))
      .toThrow(/hash mismatch/);
  });

  it('rejects a malformed lock value', () => {
    expect(() => loadLockedSet(holdoutFile(), 'not-a-hash', 'holdout')).toThrow(/64 lowercase hex/);
  });

  it('rejects text that is not JSON, and a non-object root', () => {
    expect(() => loadLockedSet('{not json', sha256Hex('{not json'), 'holdout')).toThrow(/not valid JSON/);
    expect(() => loadLockedSet('[1,2]', sha256Hex('[1,2]'), 'holdout')).toThrow(/must be a JSON object/);
  });

  it('rejects a wrong role, a missing corpus version and a non-array items field', () => {
    const asCalibration = holdoutFile().replace('"role": "holdout"', '"role": "calibration"');
    expect(() => loadLockedSet(asCalibration, sha256Hex(asCalibration), 'holdout')).toThrow(/expected holdout/);
    const noCorpus = holdoutFile().replace('"corpusVersion": "ind-corpus-v1"', '"corpusVersion": " "');
    expect(() => loadLockedSet(noCorpus, sha256Hex(noCorpus), 'holdout')).toThrow(/corpusVersion is required/);
    const noItems = JSON.stringify({ corpusVersion: 'v', role: 'holdout', items: 'nope' });
    expect(() => loadLockedSet(noItems, sha256Hex(noItems), 'holdout')).toThrow(/items must be an array/);
  });

  it('rejects items that are not objects with a string id', () => {
    const text = JSON.stringify({ corpusVersion: 'v', role: 'holdout', items: [null] });
    expect(() => loadLockedSet(text, sha256Hex(text), 'holdout')).toThrow(/object with a string id/);
  });

  it('rejects a set that fails the validator even when the hash matches', () => {
    const text = JSON.stringify({ corpusVersion: 'v', role: 'holdout', items: [] });
    expect(() => loadLockedSet(text, sha256Hex(text), 'holdout')).toThrow(/failed validation/);
  });
});

describe('toLabelledCases', () => {
  it('maps answerable items to answer labels and unanswerable items to abstain labels', () => {
    expect(toLabelledCases(small.slice(0, 2))).toEqual([
      { id: 'A1', question: 'how do refunds work alpha', expected: { kind: 'answer', sourceId: 'DOC-A' } },
      { id: 'A2', question: 'how do exports work beta', expected: { kind: 'answer', sourceId: 'DOC-A' } },
    ]);
    expect(toLabelledCases(small.slice(2, 3))[0]!.expected).toEqual({ kind: 'abstain' });
  });
});

describe('runLockedSet with mocked providers', () => {
  it('runs the real loop and records each outcome, with generation failures kept separate', async () => {
    const records = await runLockedSet(lockedSmall(), mockDeps(), policy);
    const byId = Object.fromEntries(records.map((r) => [r.id, r]));
    expect(byId.A1).toMatchObject({ status: 'answered', citations: ['DOC-A'], topSourceId: 'DOC-A' });
    expect(byId.A2).toMatchObject({ status: 'answered', citations: ['DOC-B'], topSourceId: 'DOC-B' });
    expect(byId.U1).toMatchObject({ status: 'abstained', reason: 'insufficient_evidence' });
    expect(byId.U2).toMatchObject({ status: 'answered', citations: ['DOC-A'] });
    expect(byId.U3).toMatchObject({ status: 'generation_failed', failure: 'TypeError', topSourceId: 'DOC-A' });
  });
});

describe('scoreRecords', () => {
  it('computes the automatic measures with their denominators, and marks human measures as not adjudicated', async () => {
    const records = await runLockedSet(lockedSmall(), mockDeps(), policy);
    const scores = scoreRecords(small, records, { floor: FLOOR });
    expect(scores.automatic.answerRecall).toMatchObject({ count: 1, denominator: 2, rate: 0.5 });
    expect(scores.automatic.wrongSourceAnswers).toMatchObject({ count: 1, denominator: 2 });
    expect(scores.automatic.falseAnswers).toMatchObject({ count: 1, denominator: 2 });
    expect(scores.automatic.abstentionPrecision).toMatchObject({ count: 1, denominator: 1 });
    expect(scores.automatic.retrievalFailures).toMatchObject({ count: 1, denominator: 2 });
    expect(scores.automatic.generationFailures).toMatchObject({ count: 1, denominator: 5 });
    expect(scores.automatic.citationProblems).toMatchObject({ count: 0, denominator: 3 });
    expect(scores.automatic.nearVerbatimCopy.status).toBe('not_computed');
    expect(scores.human.responsive).toMatchObject({ status: 'not_adjudicated', count: 0 });
    expect(scores.human.echo.status).toBe('not_adjudicated');
  });

  it('reports Wilson intervals with each computed rate', async () => {
    const records = await runLockedSet(lockedSmall(), mockDeps(), policy);
    const recall = scoreRecords(small, records, { floor: FLOOR }).automatic.answerRecall!;
    expect(recall.interval!.low).toBeLessThan(0.5);
    expect(recall.interval!.high).toBeGreaterThan(0.5);
  });

  it('computes human measures only when every answered item has a review row', async () => {
    const records = await runLockedSet(lockedSmall(), mockDeps(), policy);
    const row: HumanRow = { responsive: true, complete: false, supported: true, echo: false };
    const partial = scoreRecords(small, records, { floor: FLOOR, humanReview: { A1: row } });
    expect(partial.human.responsive!.status).toBe('not_adjudicated');
    const full = scoreRecords(small, records, { floor: FLOOR, humanReview: { A1: row, A2: { ...row, supported: false }, U2: { ...row, echo: true } } });
    expect(full.human.responsive).toMatchObject({ status: 'computed', count: 3, denominator: 3 });
    expect(full.human.supported).toMatchObject({ status: 'computed', count: 2, denominator: 3 });
    expect(full.human.echo).toMatchObject({ status: 'computed', count: 1, denominator: 3 });
  });

  it('computes the copying measure only when document texts are supplied', async () => {
    const records = await runLockedSet(lockedSmall(), mockDeps(), policy);
    const long = 'Refunds are accepted within thirty days of purchase, provided the item is unused and the receipt is kept for the full period.';
    const scores = scoreRecords(small, records, { floor: FLOOR, documentTexts: { 'DOC-A': long } });
    expect(scores.automatic.nearVerbatimCopy.status).toBe('computed');
    expect(scores.automatic.nearVerbatimCopy.count).toBe(0);
  });
});

describe('reproducible reports', () => {
  it('produces identical bytes for identical inputs, with sorted keys and full provenance', async () => {
    const provenance = {
      corpusVersion: 'ind-corpus-v1', role: 'holdout' as const, setSha256: 'f'.repeat(64), policy, floor: FLOOR,
      promptVersion: 'v5', model: { name: 'test-model', digest: 'd'.repeat(8) }, runnerVersion: INDEPENDENT_RUNNER_VERSION,
    };
    const first = buildReport(provenance, small, await runLockedSet(lockedSmall(), mockDeps(), policy), { floor: FLOOR });
    const second = buildReport(provenance, small, await runLockedSet(lockedSmall(), mockDeps(), policy), { floor: FLOOR });
    expect(first).toBe(second);
    const parsed = JSON.parse(first) as Record<string, unknown>;
    expect(Object.keys(parsed)).toEqual(['automatic', 'counts', 'human', 'provenance', 'records']);
    expect((parsed.provenance as { setSha256: string }).setSha256).toBe('f'.repeat(64));
  });

  it('sorts keys at every depth in stableJson', () => {
    expect(stableJson({ b: 1, a: { d: 2, c: 3 } })).toBe('{\n  "a": {\n    "c": 3,\n    "d": 2\n  },\n  "b": 1\n}\n');
  });
});

describe('scoring over records from a failed set', () => {
  it('excludes generation failures from the denominators of answer measures', () => {
    const records: ItemRecord[] = [{ id: 'U1', kind: 'unanswerable', category: 'unrelated', status: 'generation_failed', citations: [],
      answer: '', reason: '', rounds: 0, topScore: null, topSourceId: null, failure: 'Error' }];
    const scores = scoreRecords(small, records, { floor: FLOOR });
    expect(scores.automatic.falseAnswers!.denominator).toBe(0);
    expect(scores.automatic.falseAnswers!.status).toBe('no_denominator');
  });
});

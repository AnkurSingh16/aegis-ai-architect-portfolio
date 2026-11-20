import { describe, expect, it } from 'vitest';
import { type IndependentItem, MINIMUMS, validateIndependentSet } from './independent-set.js';

// Generated test data only. These question texts are placeholders for the validator and are not evaluation questions.
function answerable(n: number, category: 'paraphrase' | 'direct' = 'paraphrase'): IndependentItem {
  return {
    id: `A${String(n).padStart(3, '0')}`, question: `Placeholder answerable question number ${n} for validation`, kind: 'answerable', category,
    supportingDocumentId: 'DOC-1', keyPoints: ['a key point'], author: 'independent-author', writtenOn: '2026-12-01',
  };
}

function unanswerable(n: number, category: 'near_miss' | 'unavailable_info' | 'restricted_source' | 'unrelated'): IndependentItem {
  return {
    id: `U${String(n).padStart(3, '0')}`, question: `Placeholder unanswerable question number ${n} for validation`, kind: 'unanswerable', category,
    unanswerableReason: 'the documents do not cover it', author: 'independent-author', writtenOn: '2026-12-01',
  };
}

/** A holdout that meets every minimum exactly. */
function compliantHoldout(): IndependentItem[] {
  const items: IndependentItem[] = [];
  for (let i = 0; i < 40; i += 1) items.push(answerable(i + 1, i < 20 ? 'paraphrase' : 'direct'));
  let n = 0;
  for (let i = 0; i < 10; i += 1) items.push(unanswerable(++n, 'near_miss'));
  for (let i = 0; i < 10; i += 1) items.push(unanswerable(++n, 'unavailable_info'));
  for (let i = 0; i < 10; i += 1) items.push(unanswerable(++n, 'restricted_source'));
  for (let i = 0; i < 10; i += 1) items.push(unanswerable(++n, 'unrelated'));
  return items;
}

describe('validateIndependentSet', () => {
  it('accepts a holdout that meets every minimum', () => {
    expect(validateIndependentSet(compliantHoldout(), 'holdout')).toEqual([]);
  });

  it('reports a holdout that is one answerable short', () => {
    const items = compliantHoldout().slice(1);
    expect(validateIndependentSet(items, 'holdout')).toEqual(expect.arrayContaining(['answerable count 39 is below 40']));
  });

  it('reports a missing paraphrase minimum', () => {
    const items = compliantHoldout().map((item) => (item.category === 'paraphrase' ? { ...item, category: 'direct' as const } : item));
    expect(validateIndependentSet(items, 'holdout')).toEqual(expect.arrayContaining(['paraphrase count is below 20']));
  });

  it('reports a missing restricted-source minimum', () => {
    // Keep only seven of the ten restricted-source items: one below the minimum of eight.
    let kept = 0;
    const items = compliantHoldout().filter((item) => item.category !== 'restricted_source' || ++kept <= 7);
    expect(validateIndependentSet(items, 'holdout')).toEqual(expect.arrayContaining(['restricted_source count 7 is below 8']));
  });

  it('accepts the calibration minimums, which are smaller', () => {
    const items: IndependentItem[] = [];
    for (let i = 0; i < 20; i += 1) items.push(answerable(i + 1, i < 10 ? 'paraphrase' : 'direct'));
    let n = 0;
    for (let i = 0; i < 5; i += 1) items.push(unanswerable(++n, 'near_miss'));
    for (let i = 0; i < 5; i += 1) items.push(unanswerable(++n, 'unavailable_info'));
    for (let i = 0; i < 5; i += 1) items.push(unanswerable(++n, 'restricted_source'));
    for (let i = 0; i < 5; i += 1) items.push(unanswerable(++n, 'unrelated'));
    expect(validateIndependentSet(items, 'calibration')).toEqual([]);
    expect(MINIMUMS.calibration.answerable).toBe(20);
  });

  it('rejects duplicate ids and duplicate question text, ignoring case and punctuation', () => {
    const items = compliantHoldout();
    items[1] = { ...items[1]!, id: items[0]!.id };
    items[2] = { ...items[2]!, question: items[3]!.question.toUpperCase() + '!!' };
    const problems = validateIndependentSet(items, 'holdout');
    expect(problems).toEqual(expect.arrayContaining(['item A001: duplicate id', 'item A004: duplicate question text']));
  });

  it('rejects a question that repeats an earlier set', () => {
    const items = compliantHoldout();
    const problems = validateIndependentSet(items, 'holdout', [items[5]!.question]);
    expect(problems.some((p) => p.includes('repeats an earlier set'))).toBe(true);
  });

  it('requires key points and a supporting document for answerable items', () => {
    const items = compliantHoldout();
    items[0] = { ...items[0]!, keyPoints: [], supportingDocumentId: undefined };
    const problems = validateIndependentSet(items, 'holdout');
    expect(problems).toEqual(expect.arrayContaining([
      'item A001: answerable items need at least one non-empty key point',
      'item A001: answerable items need a supportingDocumentId',
    ]));
  });

  it('requires a reason for unanswerable items and rejects answer fields on them', () => {
    const items = compliantHoldout();
    items[40] = { ...items[40]!, unanswerableReason: '  ' };
    items[41] = { ...items[41]!, keyPoints: ['not allowed'] };
    const problems = validateIndependentSet(items, 'holdout');
    expect(problems).toEqual(expect.arrayContaining([
      'item U001: unanswerable items need a reason',
      'item U002: unanswerable items must not have a supporting document or key points',
    ]));
  });

  it('rejects an unknown kind, category, date and empty author', () => {
    const items = compliantHoldout();
    items[0] = { ...items[0]!, author: ' ', writtenOn: '2026/12/01' };
    items[40] = { ...items[40]!, category: 'bogus' as never };
    const problems = validateIndependentSet(items, 'holdout');
    expect(problems).toEqual(expect.arrayContaining([
      'item A001: author is required',
      'item A001: writtenOn must be YYYY-MM-DD',
      'item U001: unanswerable category is not recognised',
    ]));
  });

  it('rejects the blank template shape, so an unfilled template cannot pass', () => {
    const template: IndependentItem = {
      id: '<fill in>', question: '<fill in the question>', kind: 'answerable', category: 'paraphrase',
      author: '<author>', writtenOn: '<YYYY-MM-DD>',
    };
    const problems = validateIndependentSet([template], 'holdout');
    expect(problems).toEqual(expect.arrayContaining(['item <fill in>: id must be 1 to 64 letters, digits, dots, dashes or underscores']));
    expect(problems.length).toBeGreaterThan(5);
  });
});

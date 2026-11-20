import { describe, expect, it } from 'vitest';
import { holdoutCasesV3 } from './floor-cases-v3.js';
import { calibrationCasesV2, holdoutCasesV2 } from './floor-cases-v2.js';
import { holdoutCases } from './floor-cases.js';
import { syntheticDocuments } from '../documents/catalog.js';

const northSources = new Set(syntheticDocuments.filter((doc) => doc.tenant === 'north').map((doc) => doc.sourceIdentity));

describe('holdoutCasesV3 shape', () => {
  it('has twelve answerable and twelve unanswerable cases, with unique ids', () => {
    const answerable = holdoutCasesV3.filter((c) => c.expected.kind === 'answer');
    const unanswerable = holdoutCasesV3.filter((c) => c.expected.kind === 'abstain');
    expect(answerable).toHaveLength(12);
    expect(unanswerable).toHaveLength(12);
    expect(new Set(holdoutCasesV3.map((c) => c.id)).size).toBe(holdoutCasesV3.length);
  });

  it('cites only North documents, and each North document is the answer for three questions', () => {
    const cited = holdoutCasesV3.flatMap((c) => (c.expected.kind === 'answer' ? [c.expected.sourceId] : []));
    expect(cited.every((id) => northSources.has(id))).toBe(true);
    const counts = new Map<string, number>();
    for (const id of cited) counts.set(id, (counts.get(id) ?? 0) + 1);
    expect([...counts.values()]).toEqual([3, 3, 3, 3]);
  });

  it('shares no question wording with any earlier calibration or holdout set', () => {
    const earlier = new Set([...calibrationCasesV2, ...holdoutCasesV2, ...holdoutCases].map((c) => c.question.toLowerCase()));
    const reused = holdoutCasesV3.filter((c) => earlier.has(c.question.toLowerCase())).map((c) => c.id);
    expect(reused).toEqual([]);
  });
});

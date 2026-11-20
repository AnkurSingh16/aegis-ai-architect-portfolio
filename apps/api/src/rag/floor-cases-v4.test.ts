import { describe, expect, it } from 'vitest';
import { calibrationCasesV4, holdoutCasesV4 } from './floor-cases-v4.js';
import { calibrationCasesV2, holdoutCasesV2 } from './floor-cases-v2.js';
import { holdoutCasesV3 } from './floor-cases-v3.js';
import { holdoutCases, calibrationCases } from './floor-cases.js';
import { abstentionCases } from './abstention-cases.js';
import { generatorEvalCases } from './generator-cases.js';
import { generatorEvalCasesV2 } from './generator-cases-v2.js';
import { generatorEvalCasesV3 } from './generator-cases-v3.js';
import { generatorEvalCasesV4 } from './generator-cases-v4.js';
import { generatorEvalCasesV5 } from './generator-cases-v5.js';
import { generatorEvalCasesV6 } from './generator-cases-v6.js';
import { syntheticDocuments } from '../documents/catalog.js';

const northSources = new Set(syntheticDocuments.filter((doc) => doc.tenant === 'north').map((doc) => doc.sourceIdentity));
const count = (cases: typeof calibrationCasesV4, kind: 'answer' | 'abstain') => cases.filter((c) => c.expected.kind === kind).length;

describe('floor set v4 shape', () => {
  it('calibration has twenty answerable and twenty unanswerable; holdout has twelve and twelve', () => {
    expect(count(calibrationCasesV4, 'answer')).toBe(20);
    expect(count(calibrationCasesV4, 'abstain')).toBe(20);
    expect(count(holdoutCasesV4, 'answer')).toBe(12);
    expect(count(holdoutCasesV4, 'abstain')).toBe(12);
  });

  it('has unique ids across both sets', () => {
    const ids = [...calibrationCasesV4, ...holdoutCasesV4].map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('cites only North documents, and each North document is cited equally in each set', () => {
    for (const set of [calibrationCasesV4, holdoutCasesV4]) {
      const cited = set.flatMap((c) => (c.expected.kind === 'answer' ? [c.expected.sourceId] : []));
      expect(cited.every((id) => northSources.has(id))).toBe(true);
      const counts = new Map<string, number>();
      for (const id of cited) counts.set(id, (counts.get(id) ?? 0) + 1);
      expect(new Set(counts.values()).size).toBe(1);
    }
  });

  it('shares no question wording with any earlier set', () => {
    const earlier = new Set([
      ...calibrationCases, ...calibrationCasesV2, ...holdoutCasesV2, ...holdoutCasesV3, ...holdoutCases, ...abstentionCases,
      ...generatorEvalCases, ...generatorEvalCasesV2, ...generatorEvalCasesV3, ...generatorEvalCasesV4,
      ...generatorEvalCasesV5, ...generatorEvalCasesV6,
    ].map((c) => c.question.toLowerCase()));
    const reused = [...calibrationCasesV4, ...holdoutCasesV4].filter((c) => earlier.has(c.question.toLowerCase())).map((c) => c.id);
    expect(reused).toEqual([]);
  });
});

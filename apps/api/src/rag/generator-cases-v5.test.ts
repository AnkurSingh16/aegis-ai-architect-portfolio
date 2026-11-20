import { describe, expect, it } from 'vitest';
import { generatorEvalCasesV5 } from './generator-cases-v5.js';
import { generatorEvalCases } from './generator-cases.js';
import { generatorEvalCasesV2 } from './generator-cases-v2.js';
import { generatorEvalCasesV3 } from './generator-cases-v3.js';
import { generatorEvalCasesV4 } from './generator-cases-v4.js';
import { calibrationCasesV2, holdoutCasesV2 } from './floor-cases-v2.js';
import { holdoutCasesV3 } from './floor-cases-v3.js';
import { holdoutCases } from './floor-cases.js';
import { abstentionCases } from './abstention-cases.js';
import { syntheticDocuments } from '../documents/catalog.js';

const northSources = new Set(syntheticDocuments.filter((doc) => doc.tenant === 'north').map((doc) => doc.sourceIdentity));

describe('generatorEvalCasesV5 shape', () => {
  it('has twelve answerable and twelve unanswerable cases, with unique ids', () => {
    expect(generatorEvalCasesV5.filter((c) => c.expected.kind === 'answer')).toHaveLength(12);
    expect(generatorEvalCasesV5.filter((c) => c.expected.kind === 'abstain')).toHaveLength(12);
    expect(new Set(generatorEvalCasesV5.map((c) => c.id)).size).toBe(generatorEvalCasesV5.length);
  });

  it('cites only North documents, three per document', () => {
    const cited = generatorEvalCasesV5.flatMap((c) => (c.expected.kind === 'answer' ? [c.expected.sourceId] : []));
    expect(cited.every((id) => northSources.has(id))).toBe(true);
    const counts = new Map<string, number>();
    for (const id of cited) counts.set(id, (counts.get(id) ?? 0) + 1);
    expect([...counts.values()]).toEqual([3, 3, 3, 3]);
  });

  it('shares no question wording with any earlier set', () => {
    const earlier = new Set([
      ...calibrationCasesV2, ...holdoutCasesV2, ...holdoutCasesV3, ...holdoutCases, ...abstentionCases,
      ...generatorEvalCases, ...generatorEvalCasesV2, ...generatorEvalCasesV3, ...generatorEvalCasesV4,
    ].map((c) => c.question.toLowerCase()));
    const reused = generatorEvalCasesV5.filter((c) => earlier.has(c.question.toLowerCase())).map((c) => c.id);
    expect(reused).toEqual([]);
  });
});

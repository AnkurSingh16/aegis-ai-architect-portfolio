import { describe, expect, it } from 'vitest';
import { retrievalSetV2Cases } from './retrieval-set-v2-cases.js';
import { retrievalRerankCasesV1 } from './retrieval-rerank-cases-v1.js';
import { generatorEvalCases } from './generator-cases.js';
import { generatorEvalCasesV2 } from './generator-cases-v2.js';
import { generatorEvalCasesV3 } from './generator-cases-v3.js';
import { generatorEvalCasesV4 } from './generator-cases-v4.js';
import { generatorEvalCasesV5 } from './generator-cases-v5.js';
import { generatorEvalCasesV6 } from './generator-cases-v6.js';
import { generatorEvalCasesV7 } from './generator-cases-v7.js';
import { calibrationCasesV2, holdoutCasesV2 } from './floor-cases-v2.js';
import { holdoutCasesV3 } from './floor-cases-v3.js';
import { holdoutCases, calibrationCases } from './floor-cases.js';
import { calibrationCasesV4, holdoutCasesV4 } from './floor-cases-v4.js';
import { abstentionCases } from './abstention-cases.js';
import { syntheticDocuments } from '../documents/catalog.js';

const northSources = new Set(syntheticDocuments.filter((doc) => doc.tenant === 'north').map((doc) => doc.sourceIdentity));

describe('retrievalSetV2Cases shape', () => {
  it('has twelve answerable and twelve unanswerable cases, with unique ids', () => {
    expect(retrievalSetV2Cases.filter((c) => c.expected.kind === 'answer')).toHaveLength(12);
    expect(retrievalSetV2Cases.filter((c) => c.expected.kind === 'abstain')).toHaveLength(12);
    expect(new Set(retrievalSetV2Cases.map((c) => c.id)).size).toBe(retrievalSetV2Cases.length);
  });

  it('cites only North documents, three per document', () => {
    const cited = retrievalSetV2Cases.flatMap((c) => (c.expected.kind === 'answer' ? [c.expected.sourceId] : []));
    expect(cited.every((id) => northSources.has(id))).toBe(true);
    const counts = new Map<string, number>();
    for (const id of cited) counts.set(id, (counts.get(id) ?? 0) + 1);
    expect([...counts.values()]).toEqual([3, 3, 3, 3]);
  });

  it('shares no question wording with any earlier set', () => {
    const earlier = new Set([
      ...calibrationCases, ...calibrationCasesV2, ...holdoutCasesV2, ...holdoutCasesV3, ...holdoutCases, ...abstentionCases,
      ...calibrationCasesV4, ...holdoutCasesV4,
      ...generatorEvalCases, ...generatorEvalCasesV2, ...generatorEvalCasesV3, ...generatorEvalCasesV4,
      ...generatorEvalCasesV5, ...generatorEvalCasesV6, ...generatorEvalCasesV7,
      ...retrievalRerankCasesV1,
    ].map((c) => c.question.toLowerCase()));
    const reused = retrievalSetV2Cases.filter((c) => earlier.has(c.question.toLowerCase())).map((c) => c.id);
    expect(reused).toEqual([]);
  });
});

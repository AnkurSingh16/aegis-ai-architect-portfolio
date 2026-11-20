import { describe, expect, it } from 'vitest';
import { retrievalSetV3Primary, retrievalSetV3Spares } from './retrieval-set-v3-cases.js';
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
const answerable = retrievalSetV3Primary.filter((c) => c.expected.kind === 'answer');

describe('retrieval set v3 shape', () => {
  it('has twelve answerable and twelve unanswerable primary cases, with unique ids', () => {
    expect(answerable).toHaveLength(12);
    expect(retrievalSetV3Primary.filter((c) => c.expected.kind === 'abstain')).toHaveLength(12);
    const ids = [...retrievalSetV3Primary, ...retrievalSetV3Spares].map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('cites only North documents, three primary and one spare per document', () => {
    const primaryCited = answerable.map((c) => (c.expected.kind === 'answer' ? c.expected.sourceId : ''));
    expect(primaryCited.every((id) => northSources.has(id))).toBe(true);
    const counts = new Map<string, number>();
    for (const id of primaryCited) counts.set(id, (counts.get(id) ?? 0) + 1);
    expect([...counts.values()]).toEqual([3, 3, 3, 3]);
    const spareCited = retrievalSetV3Spares.map((c) => (c.expected.kind === 'answer' ? c.expected.sourceId : ''));
    expect(spareCited.every((id) => northSources.has(id))).toBe(true);
    for (const sourceId of northSources) {
      expect(spareCited.filter((id) => id === sourceId)).toHaveLength(3);
    }
  });

  it('pairs every spare with a primary answerable question from the same document, one spare each', () => {
    const replaced = retrievalSetV3Spares.map((spare) => spare.replacesId);
    expect(new Set(replaced).size).toBe(replaced.length);
    for (const spare of retrievalSetV3Spares) {
      const primary = answerable.find((c) => c.id === spare.replacesId);
      expect(primary).toBeDefined();
      expect(primary!.expected).toEqual(spare.expected);
    }
    expect(replaced.sort()).toEqual(answerable.map((c) => c.id).sort());
  });

  it('shares no question wording with any earlier set', () => {
    const earlier = new Set([
      ...calibrationCases, ...calibrationCasesV2, ...holdoutCasesV2, ...holdoutCasesV3, ...holdoutCases, ...abstentionCases,
      ...calibrationCasesV4, ...holdoutCasesV4,
      ...generatorEvalCases, ...generatorEvalCasesV2, ...generatorEvalCasesV3, ...generatorEvalCasesV4,
      ...generatorEvalCasesV5, ...generatorEvalCasesV6, ...generatorEvalCasesV7,
      ...retrievalRerankCasesV1, ...retrievalSetV2Cases,
    ].map((c) => c.question.toLowerCase()));
    const reused = [...retrievalSetV3Primary, ...retrievalSetV3Spares]
      .filter((c) => earlier.has(c.question.toLowerCase())).map((c) => c.id);
    expect(reused).toEqual([]);
  });
});

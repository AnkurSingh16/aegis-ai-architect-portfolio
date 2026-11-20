import { tokenize } from './bm25.js';
import { largeCorpusDocuments, largeCorpusQueries } from './large-dev-corpus.js';

/**
 * 100 development queries: the 50 pure paraphrases, plus 50 augmented versions that add 1, 2 or 3 content words
 * from the target document. Augmentation is deterministic. Dev/test split is by index parity, and tuning uses dev only.
 */
export interface MixedQuery { id: string; target: string; query: string; kind: 'paraphrase' | 'augmented'; overlap: number; split: 'dev' | 'test' }

export function mixedRetrievalQueries(): MixedQuery[] {
  const base: Omit<MixedQuery, 'split'>[] = largeCorpusQueries.map((q) => ({ id: q.id, target: q.target, query: q.query, kind: 'paraphrase', overlap: 0 }));
  const augmented: Omit<MixedQuery, 'split'>[] = largeCorpusQueries.map((q, index) => {
    const doc = largeCorpusDocuments.find((d) => d.id === q.target)!;
    const unique = [...new Set(tokenize(doc.text))];
    const count = [1, 2, 3][index % 3]!;
    const picks: string[] = [];
    for (let k = 0; k < count; k += 1) picks.push(unique[(index * 7 + k * 5) % unique.length]!);
    return { id: `${q.id}A`, target: q.target, query: `${q.query} ${[...new Set(picks)].join(' ')}`, kind: 'augmented', overlap: new Set(picks).size };
  });
  return [...base, ...augmented].map((q, index) => ({ ...q, split: index % 2 === 0 ? 'dev' : 'test' }));
}

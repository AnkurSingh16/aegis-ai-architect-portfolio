/**
 * 100-query mixed development benchmark with a held-out split. The fusion weight is chosen on dev queries only,
 * then reported once on test queries. Loopback Ollama only; bounded batches of 8; no retries.
 * Usage: npx tsx apps/api/scripts/mixed-retrieval-benchmark.ts <output.json>
 */
import { writeFileSync } from 'node:fs';
import { embedTexts, EMBEDDING_MODEL, EMBEDDING_MODEL_DIGEST } from '../src/retrieval/ollama-embeddings.js';
import { bm25Rank } from '../src/retrieval/eval/bm25.js';
import { largeCorpusDocuments } from '../src/retrieval/eval/large-dev-corpus.js';
import { mixedRetrievalQueries } from '../src/retrieval/eval/mixed-queries.js';
import { meanReciprocalRank, ndcgAtK, recallAtK, reciprocalRankFusion, weightedReciprocalRankFusion } from '../src/retrieval/ranking-metrics.js';

const outputPath = process.argv[2];
if (!outputPath) throw new Error('usage: mixed-retrieval-benchmark.ts <output.json>');

async function embedAll(texts: readonly string[], kind: 'search_document' | 'search_query'): Promise<number[][]> {
  const vectors: number[][] = [];
  for (let i = 0; i < texts.length; i += 8) vectors.push(...await embedTexts(texts.slice(i, i + 8), kind));
  return vectors;
}
const cosine = (a: readonly number[], b: readonly number[]) => {
  let dot = 0; let na = 0; let nb = 0;
  for (let i = 0; i < a.length; i += 1) { dot += a[i]! * b[i]!; na += a[i]! * a[i]!; nb += b[i]! * b[i]!; }
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
};

const queries = mixedRetrievalQueries();
const docIds = largeCorpusDocuments.map((d) => d.id);
const docVectors = await embedAll(largeCorpusDocuments.map((d) => d.text), 'search_document');
const queryVectors = await embedAll(queries.map((q) => q.query), 'search_query');
const corpus = largeCorpusDocuments.map((d) => ({ id: d.id, text: d.text }));

const rows = queries.map((q, index) => {
  const relevant = new Set([q.target]);
  const lexical = bm25Rank(q.query, corpus);
  const vector = docIds.map((id, i) => ({ id, score: cosine(queryVectors[index]!, docVectors[i]!) }))
    .sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1)).map((r) => r.id);
  return { q, relevant, lexical, vector };
});

const weights = Array.from({ length: 21 }, (_, i) => i / 20);
const score = (subset: typeof rows, approach: (r: (typeof rows)[number]) => string[]) => ({
  mrr: meanReciprocalRank(subset.map((r) => ({ ranked: approach(r), relevant: r.relevant }))),
  recallAt10: subset.reduce((s, r) => s + recallAtK(approach(r), r.relevant, 10), 0) / subset.length,
  ndcgAt10: subset.reduce((s, r) => s + ndcgAtK(approach(r), new Map([[r.q.target, 1]]), 10), 0) / subset.length,
});

const dev = rows.filter((r) => r.q.split === 'dev');
const test = rows.filter((r) => r.q.split === 'test');
const sweep = weights.map((w) => ({ w, dev: score(dev, (r) => weightedReciprocalRankFusion(r.lexical, r.vector, w)).mrr }));
const bestDev = sweep.reduce((best, row) => (row.dev > best.dev + 1e-12 ? row : best));
const approaches = {
  lexical: (r: (typeof rows)[number]) => r.lexical,
  vector: (r: (typeof rows)[number]) => r.vector,
  equalRrf: (r: (typeof rows)[number]) => reciprocalRankFusion([r.lexical, r.vector]),
  tunedWeighted: (r: (typeof rows)[number]) => weightedReciprocalRankFusion(r.lexical, r.vector, bestDev.w),
};
const report = (subset: typeof rows) => Object.fromEntries(Object.entries(approaches).map(([name, fn]) => [name, score(subset, fn)]));

const evidence = {
  queries: queries.length, dev: dev.length, test: test.length, model: EMBEDDING_MODEL, modelDigest: EMBEDDING_MODEL_DIGEST,
  endpoint: 'http://127.0.0.1:11434', selectedFusionWeight: bestDev.w, selectionRule: 'max dev MRR over w in {0,0.05,...,1}; ties keep the first (lowest w)',
  sweepDev: sweep, heldOutTest: report(test), allQueries: report(rows),
  byKind: { paraphrase: report(rows.filter((r) => r.q.kind === 'paraphrase')), augmented: report(rows.filter((r) => r.q.kind === 'augmented')) },
};
writeFileSync(outputPath, `${JSON.stringify(evidence, null, 2)}\n`);
console.log(JSON.stringify({ selectedFusionWeight: evidence.selectedFusionWeight, heldOutTest: evidence.heldOutTest }, null, 2));

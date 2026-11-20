/**
 * Development retrieval benchmark over the 50-document synthetic evaluation corpus.
 * Compares BM25 (lexical), cosine over local nomic-embed-text vectors, and reciprocal rank fusion of both.
 * Loopback Ollama only. Bounded: 100 embedding texts in batches of 8, no retries.
 * Usage: npx tsx apps/api/scripts/large-retrieval-benchmark.ts <output.json>
 */
import { writeFileSync } from 'node:fs';
import { embedTexts, EMBEDDING_MODEL, EMBEDDING_MODEL_DIGEST } from '../src/retrieval/ollama-embeddings.js';
import { bm25Rank } from '../src/retrieval/eval/bm25.js';
import { largeCorpusDocuments, largeCorpusQueries, largeCorpusVersion } from '../src/retrieval/eval/large-dev-corpus.js';
import { ndcgAtK, recallAtK, reciprocalRank, reciprocalRankFusion } from '../src/retrieval/ranking-metrics.js';

const outputPath = process.argv[2];
if (!outputPath) throw new Error('usage: large-retrieval-benchmark.ts <output.json>');

async function embedAll(texts: readonly string[], kind: 'search_document' | 'search_query'): Promise<number[][]> {
  const vectors: number[][] = [];
  for (let i = 0; i < texts.length; i += 8) vectors.push(...await embedTexts(texts.slice(i, i + 8), kind));
  return vectors;
}

const cosine = (a: readonly number[], b: readonly number[]): number => {
  let dot = 0; let na = 0; let nb = 0;
  for (let i = 0; i < a.length; i += 1) { dot += a[i]! * b[i]!; na += a[i]! * a[i]!; nb += b[i]! * b[i]!; }
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
};

const docVectors = await embedAll(largeCorpusDocuments.map((d) => d.text), 'search_document');
const queryVectors = await embedAll(largeCorpusQueries.map((q) => q.query), 'search_query');
const docIds = largeCorpusDocuments.map((d) => d.id);

const perQuery = largeCorpusQueries.map((q, index) => {
  const relevant = new Set([q.target]);
  const grades = new Map([[q.target, 1]]);
  const lexical = bm25Rank(q.query, largeCorpusDocuments.map((d) => ({ id: d.id, text: d.text })));
  // Vector ranking over all documents: no candidate filtering, so every approach ranks the full pool.
  const vector = docIds
    .map((id, i) => ({ id, score: cosine(queryVectors[index]!, docVectors[i]!) }))
    .sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1))
    .map((row) => row.id);
  const hybrid = reciprocalRankFusion([lexical, vector]);
  return { id: q.id, approaches: {
    lexical: { recallAt10: recallAtK(lexical, relevant, 10), reciprocalRank: reciprocalRank(lexical, relevant), ndcgAt10: ndcgAtK(lexical, grades, 10), top1: lexical[0] ?? null },
    vector: { recallAt10: recallAtK(vector, relevant, 10), reciprocalRank: reciprocalRank(vector, relevant), ndcgAt10: ndcgAtK(vector, grades, 10), top1: vector[0] ?? null },
    hybrid: { recallAt10: recallAtK(hybrid, relevant, 10), reciprocalRank: reciprocalRank(hybrid, relevant), ndcgAt10: ndcgAtK(hybrid, grades, 10), top1: hybrid[0] ?? null },
  } };
});

const mean = (approach: 'lexical' | 'vector' | 'hybrid', key: 'recallAt10' | 'reciprocalRank' | 'ndcgAt10') =>
  perQuery.reduce((sum, row) => sum + row.approaches[approach][key], 0) / perQuery.length;

const summary = Object.fromEntries((['lexical', 'vector', 'hybrid'] as const).map((approach) => [approach, {
  meanRecallAt10: mean(approach, 'recallAt10'), meanReciprocalRank: mean(approach, 'reciprocalRank'), meanNdcgAt10: mean(approach, 'ndcgAt10'),
}]));

const evidence = {
  corpusVersion: largeCorpusVersion, documents: largeCorpusDocuments.length, queries: largeCorpusQueries.length,
  candidatePoolPerQuery: largeCorpusDocuments.length, model: EMBEDDING_MODEL, modelDigest: EMBEDDING_MODEL_DIGEST,
  endpoint: 'http://127.0.0.1:11434', lexical: 'BM25 (k1=1.2, b=0.75), no stemming', fusion: 'reciprocal rank fusion, k0=60',
  embeddingTexts: docVectors.length + queryVectors.length, summary, perQuery,
};
writeFileSync(outputPath, `${JSON.stringify(evidence, null, 2)}\n`);
console.log(JSON.stringify(summary, null, 2));

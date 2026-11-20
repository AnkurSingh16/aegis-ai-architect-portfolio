/**
 * One pre-registered run of the ranking test (docs/DEV-RETRIEVAL-RANKING-TEST-PROTOCOL.md) for the candidate in
 * docs/DEV-RETRIEVAL-CANDIDATE-GATED-LEXICAL.md. Baseline: vector cosine over local nomic-embed-text. Candidate: the gated
 * lexical rule. Paired bootstrap, 10,000 resamples, fixed seed. Loopback Ollama only. Run once.
 * Usage: npx tsx apps/api/scripts/gated-lexical-ranking-benchmark.ts <output.json>
 */
import { writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { embedTexts, EMBEDDING_MODEL, EMBEDDING_MODEL_DIGEST } from '../src/retrieval/ollama-embeddings.js';
import { bm25Scores } from '../src/retrieval/eval/bm25.js';
import { largeCorpusDocuments, largeCorpusVersion } from '../src/retrieval/eval/large-dev-corpus.js';
import { rankingQueriesV1 } from '../src/retrieval/eval/ranking-queries-v1.js';
import { gatedLexicalRank, GATE } from '../src/retrieval/eval/gated-lexical.js';
import { ndcgAtK, recallAtK, reciprocalRank } from '../src/retrieval/ranking-metrics.js';

const outputPath = process.argv[2];
if (!outputPath) throw new Error('usage: gated-lexical-ranking-benchmark.ts <output.json>');

const RESAMPLES = 10_000;
const SEED = 20261120;

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

// Seeded generator (mulberry32) so the bootstrap is reproducible.
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function bootstrapInterval(diffs: readonly number[], random: () => number): { mean: number; low: number; high: number } {
  const n = diffs.length;
  const means: number[] = [];
  for (let r = 0; r < RESAMPLES; r += 1) {
    let sum = 0;
    for (let i = 0; i < n; i += 1) sum += diffs[Math.floor(random() * n)]!;
    means.push(sum / n);
  }
  means.sort((a, b) => a - b);
  const mean = diffs.reduce((s, d) => s + d, 0) / n;
  return { mean, low: means[Math.floor(0.025 * RESAMPLES)]!, high: means[Math.floor(0.975 * RESAMPLES)]! };
}

const docIds = largeCorpusDocuments.map((d) => d.id);
const docVectors = await embedAll(largeCorpusDocuments.map((d) => d.text), 'search_document');
const queryVectors = await embedAll(rankingQueriesV1.map((q) => q.query), 'search_query');
const bm25Docs = largeCorpusDocuments.map((d) => ({ id: d.id, text: d.text }));

interface Row {
  id: string; kind: 'paraphrase' | 'augmented'; target: string;
  baselineRank: number | null; candidateRank: number | null;
  baselineTop1: string | null; candidateTop1: string | null; promoted: boolean; promotedTargetHit: boolean | null;
  baselineRR: number; candidateRR: number; baselineNdcg: number; candidateNdcg: number;
  baselineRecall: number; candidateRecall: number; gateMs: number;
}

const rows: Row[] = rankingQueriesV1.map((q, index) => {
  const relevant = new Set([q.target]);
  const grades = new Map([[q.target, 1]]);
  const vectorScored = docIds
    .map((id, i) => ({ id, score: cosine(queryVectors[index]!, docVectors[i]!) }))
    .sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1));
  const vector = vectorScored.map((row) => row.id);

  const started = performance.now();
  const lexicalScored = bm25Scores(q.query, bm25Docs);
  const candidate = gatedLexicalRank(vectorScored, lexicalScored);
  const gateMs = performance.now() - started;

  const promoted = candidate[0] !== vector[0];
  const rankOf = (ranked: readonly string[]): number | null => {
    const at = ranked.indexOf(q.target);
    return at === -1 ? null : at + 1;
  };
  return {
    id: q.id, kind: q.kind, target: q.target,
    baselineRank: rankOf(vector), candidateRank: rankOf(candidate),
    baselineTop1: vector[0] ?? null, candidateTop1: candidate[0] ?? null,
    promoted, promotedTargetHit: promoted ? candidate[0] === q.target : null,
    baselineRR: reciprocalRank(vector, relevant), candidateRR: reciprocalRank(candidate, relevant),
    baselineNdcg: ndcgAtK(vector, grades, 10), candidateNdcg: ndcgAtK(candidate, grades, 10),
    baselineRecall: recallAtK(vector, relevant, 10), candidateRecall: recallAtK(candidate, relevant, 10),
    gateMs,
  };
});

const mean = (values: readonly number[]): number => values.reduce((s, v) => s + v, 0) / values.length;
const summarise = (subset: readonly Row[]) => ({
  queries: subset.length,
  baselineTop1: subset.filter((r) => r.baselineRank === 1).length / subset.length,
  candidateTop1: subset.filter((r) => r.candidateRank === 1).length / subset.length,
  baselineMRR: mean(subset.map((r) => r.baselineRR)),
  candidateMRR: mean(subset.map((r) => r.candidateRR)),
  baselineRecallAt10: mean(subset.map((r) => r.baselineRecall)),
  candidateRecallAt10: mean(subset.map((r) => r.candidateRecall)),
  baselineNdcgAt10: mean(subset.map((r) => r.baselineNdcg)),
  candidateNdcgAt10: mean(subset.map((r) => r.candidateNdcg)),
  promotions: subset.filter((r) => r.promoted).length,
  promotionsOnTarget: subset.filter((r) => r.promotedTargetHit === true).length,
});

const random = mulberry32(SEED);
const overallDiffs = rows.map((r) => r.candidateRR - r.baselineRR);
const overall = bootstrapInterval(overallDiffs, random);
const top1Diffs = rows.map((r) => (r.candidateRank === 1 ? 1 : 0) - (r.baselineRank === 1 ? 1 : 0));
const top1 = bootstrapInterval(top1Diffs, random);

const perGroup = {
  paraphrase: summarise(rows.filter((r) => r.kind === 'paraphrase')),
  augmented: summarise(rows.filter((r) => r.kind === 'augmented')),
};
const groupMrrDiffs = (kind: 'paraphrase' | 'augmented') => rows.filter((r) => r.kind === kind).map((r) => r.candidateRR - r.baselineRR);
const groupInterval = {
  paraphrase: bootstrapInterval(groupMrrDiffs('paraphrase'), random),
  augmented: bootstrapInterval(groupMrrDiffs('augmented'), random),
};

const latencies = rows.map((r) => r.gateMs).sort((a, b) => a - b);
const acceptance = {
  condition1_mrrIntervalExcludesZeroPositive: overall.low > 0,
  condition2_paraphraseNotWorse: perGroup.paraphrase.candidateMRR >= perGroup.paraphrase.baselineMRR,
  condition3_latencyReported: true,
};

const evidence = {
  corpusVersion: largeCorpusVersion, documents: largeCorpusDocuments.length, queries: rankingQueriesV1.length,
  model: EMBEDDING_MODEL, modelDigest: EMBEDDING_MODEL_DIGEST, endpoint: 'http://127.0.0.1:11434',
  gate: GATE, bootstrap: { resamples: RESAMPLES, seed: SEED, method: 'paired percentile, query-level resampling' },
  overall: summarise(rows), perGroup, mrrDifference: { ...overall }, top1Difference: { ...top1 },
  groupMrrDifference: groupInterval,
  latencyMs: { medianGate: latencies[Math.floor(latencies.length / 2)], maxGate: latencies[latencies.length - 1], note: 'BM25 pass plus gate, excluding embedding' },
  acceptance,
  perQuery: rows,
};
writeFileSync(outputPath, `${JSON.stringify(evidence, null, 2)}\n`);
console.log(JSON.stringify({ overall: evidence.overall, perGroup, mrrDifference: evidence.mrrDifference,
  top1Difference: evidence.top1Difference, groupMrrDifference: evidence.groupMrrDifference, latencyMs: evidence.latencyMs, acceptance }, null, 2));

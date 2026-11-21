import { createHash } from 'node:crypto';

/**
 * Deterministic synthetic corpus for the retrieval benchmark. No model is involved: the vocabulary, the text and the embeddings
 * all come from a seeded generator. Embeddings are built around cluster centres plus seeded noise, so the vector space has
 * structure (near neighbours exist), and each cluster has its own words, so lexical and vector retrieval are both meaningful.
 */
export const EMBEDDING_DIM = 768;

export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SYLLABLES = ['ka', 'lo', 'mi', 'ter', 'su', 'vo', 'ren', 'da', 'pix', 'quo', 'ze', 'tal', 'bri', 'nol', 'fe', 'gar'];

/** A fixed vocabulary of pronounceable synthetic words. Index 0 is the most frequent in generated text (Zipf-like sampling). */
export function vocabulary(size: number): string[] {
  const rand = mulberry32(20261121);
  const words = new Set<string>();
  while (words.size < size) {
    const parts = 2 + Math.floor(rand() * 2);
    let word = '';
    for (let i = 0; i < parts; i += 1) word += SYLLABLES[Math.floor(rand() * SYLLABLES.length)];
    words.add(word);
  }
  return [...words];
}

export interface SyntheticDocument {
  readonly index: number;
  readonly tenant: 'a' | 'b';
  readonly sourceIdentity: string;
  readonly cluster: number;
  readonly content: string;
  readonly contentSha256: string;
  readonly vector: number[];
}

export interface SyntheticCorpusOptions {
  readonly documents: number;
  readonly clusters: number;
  readonly seed: number;
  /** Fraction of documents (0 to 1) given to the second tenant, for isolation checks. */
  readonly secondTenantShare: number;
}

export function generateCorpus(options: SyntheticCorpusOptions): { documents: SyntheticDocument[]; centres: number[][]; vocab: string[] } {
  const vocab = vocabulary(600);
  const rand = mulberry32(options.seed);
  const centres = Array.from({ length: options.clusters }, () => Array.from({ length: EMBEDDING_DIM }, () => rand() - 0.5));
  const documents: SyntheticDocument[] = [];
  for (let index = 0; index < options.documents; index += 1) {
    const cluster = index % options.clusters;
    const clusterWords = vocab.slice(cluster * 20, cluster * 20 + 20);
    const length = 40 + Math.floor(rand() * 40);
    const words: string[] = [];
    for (let w = 0; w < length; w += 1) {
      // Half the words come from the document's own cluster vocabulary, half from the shared vocabulary with a Zipf-like skew.
      if (rand() < 0.5) words.push(clusterWords[Math.floor(rand() * clusterWords.length)]!);
      else words.push(vocab[Math.min(vocab.length - 1, Math.floor(Math.pow(rand(), 3) * vocab.length))]!);
    }
    const content = words.join(' ');
    const vector = centres[cluster]!.map((c) => c + (rand() - 0.5) * 0.4);
    documents.push({
      index, tenant: rand() < options.secondTenantShare ? 'b' : 'a',
      sourceIdentity: `SYNTHETIC-BENCH-DOC-${String(index + 1).padStart(6, '0')}`, cluster, content,
      contentSha256: createHash('sha256').update(content, 'utf8').digest('hex'), vector,
    });
  }
  return { documents, centres, vocab };
}

/** A query vector near a cluster centre (seeded), and the matching text query made of that cluster's words. */
export function clusterQuery(corpus: { centres: number[][]; vocab: string[] }, cluster: number, seed: number) {
  const rand = mulberry32(seed);
  const vector = corpus.centres[cluster]!.map((c) => c + (rand() - 0.5) * 0.2);
  const clusterWords = corpus.vocab.slice(cluster * 20, cluster * 20 + 20);
  return { vector, text: `${clusterWords[0]} ${clusterWords[1]}`, cluster };
}

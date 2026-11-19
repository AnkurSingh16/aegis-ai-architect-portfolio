/** Lexical baseline for the development evaluation: BM25 over lowercased word tokens, no stemming. Pure, no I/O. */
const STOPWORDS = new Set(['a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'for', 'from', 'i', 'in', 'into', 'is', 'it', 'of', 'on',
  'or', 'the', 'to', 'with', 'my', 'me', 'we', 'our', 'you', 'your', 'that', 'this', 'there', 'they', 'not', 'no', 'so', 'if', 'do',
  'does', 'can', 'will', 'should', 'must', 'only', 'after', 'before', 'until', 'when', 'than', 'but', 'was', 'were', 'has', 'have']);

export function tokenize(text: string): string[] {
  return text.toLowerCase().split(/[^a-z0-9]+/).filter((token) => token.length > 0 && !STOPWORDS.has(token));
}

export interface Bm25Document { id: string; text: string }

export function bm25Rank(query: string, documents: readonly Bm25Document[], k1 = 1.2, b = 0.75): string[] {
  if (documents.length === 0) return [];
  const docs = documents.map((doc) => ({ id: doc.id, tokens: tokenize(doc.text) }));
  const avgLength = docs.reduce((sum, doc) => sum + doc.tokens.length, 0) / docs.length || 1;
  const documentFrequency = new Map<string, number>();
  for (const doc of docs) {
    for (const term of new Set(doc.tokens)) documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
  }
  const queryTerms = [...new Set(tokenize(query))];
  const n = docs.length;
  const scored = docs.map((doc) => {
    let score = 0;
    for (const term of queryTerms) {
      const tf = doc.tokens.filter((token) => token === term).length;
      if (tf === 0) continue;
      const df = documentFrequency.get(term) ?? 0;
      const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5));
      score += idf * ((tf * (k1 + 1)) / (tf + k1 * (1 - b + (b * doc.tokens.length) / avgLength)));
    }
    return { id: doc.id, score };
  });
  return scored.filter((row) => row.score > 0).sort((a, c) => c.score - a.score || (a.id < c.id ? -1 : a.id > c.id ? 1 : 0)).map((row) => row.id);
}

export { STOPWORDS };

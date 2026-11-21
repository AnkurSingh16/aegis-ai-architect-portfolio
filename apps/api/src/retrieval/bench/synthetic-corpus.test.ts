import { describe, expect, it } from 'vitest';
import { clusterQuery, EMBEDDING_DIM, generateCorpus } from './synthetic-corpus.js';

const options = { documents: 60, clusters: 6, seed: 7, secondTenantShare: 0.1 };

describe('synthetic benchmark corpus', () => {
  it('is deterministic for a seed', () => {
    const a = generateCorpus(options);
    const b = generateCorpus(options);
    expect(a.documents.map((d) => d.contentSha256)).toEqual(b.documents.map((d) => d.contentSha256));
    expect(a.documents[5]!.vector).toEqual(b.documents[5]!.vector);
  });

  it('keeps each document within the chunk size limit and hashes its own content', () => {
    for (const doc of generateCorpus(options).documents) {
      expect(Buffer.byteLength(doc.content, 'utf8')).toBeLessThanOrEqual(8192);
      expect(doc.contentSha256).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('gives every embedding the production dimension', () => {
    for (const doc of generateCorpus(options).documents.slice(0, 5)) expect(doc.vector).toHaveLength(EMBEDDING_DIM);
  });

  it('places documents of one cluster near their centre, so the vector space has structure', () => {
    const corpus = generateCorpus(options);
    const d0 = corpus.documents.find((d) => d.cluster === 0)!;
    const sameCluster = corpus.documents.find((d) => d.cluster === 0 && d !== d0)!;
    const otherCluster = corpus.documents.find((d) => d.cluster === 1)!;
    const dist = (a: number[], b: number[]) => Math.sqrt(a.reduce((s, v, i) => s + (v - b[i]!) ** 2, 0));
    expect(dist(d0.vector, sameCluster.vector)).toBeLessThan(dist(d0.vector, otherCluster.vector));
  });

  it('gives a second tenant some documents, for isolation checks', () => {
    const tenants = new Set(generateCorpus(options).documents.map((d) => d.tenant));
    expect(tenants.has('a')).toBe(true);
    expect(tenants.has('b')).toBe(true);
  });

  it('builds cluster queries whose text uses that cluster\'s own words', () => {
    const corpus = generateCorpus(options);
    const q = clusterQuery(corpus, 2, 99);
    expect(q.vector).toHaveLength(EMBEDDING_DIM);
    expect(q.text.split(' ')).toHaveLength(2);
    expect(corpus.vocab.slice(40, 60)).toContain(q.text.split(' ')[0]!);
  });
});

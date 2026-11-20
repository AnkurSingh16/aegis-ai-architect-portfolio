import { describe, expect, it } from 'vitest';
import { syntheticDocuments } from '../documents/catalog.js';
import { createOllamaGenerator, GENERATOR_MODEL, GENERATOR_MODEL_DIGEST } from './ollama-generator.js';

// Gated: one call to the local loopback chat model (AEGIS_LIVE_OLLAMA=1). This checks the pinned digest and the shape of
// one response. It makes no claim about answer quality; that needs a separate, pre-registered evaluation.
const live = process.env.AEGIS_LIVE_OLLAMA === '1';

describe.skipIf(!live)('local answer generator, live smoke test', () => {
  it('serves the pinned digest and returns a text candidate for one grounded question', async () => {
    const tags = await fetch('http://127.0.0.1:11434/api/tags').then((response) => response.json() as Promise<{ models: { name: string; digest: string }[] }>);
    expect(tags.models.find((model) => model.name === GENERATOR_MODEL)?.digest).toBe(GENERATOR_MODEL_DIGEST);

    const login = syntheticDocuments.find((document) => document.sourceIdentity === 'SYNTHETIC-NORTH-LOGIN-INCIDENT');
    expect(login).toBeDefined();
    const generate = createOllamaGenerator();
    const answer = await generate({
      question: 'Which details should be recorded for a sign-in interruption?',
      query: 'sign-in interruption details',
      evidence: [{ sourceId: login!.sourceIdentity, text: login!.content, score: 1 }],
      feedback: [],
    });
    expect(typeof answer).toBe('string');
    expect(answer.length).toBeGreaterThan(0);
    // Any citation it writes must be the one source it was given.
    const cited = [...answer.matchAll(/\[([A-Z0-9_-]+)\]/g)].map((match) => match[1]);
    expect(cited.every((id) => id === login!.sourceIdentity)).toBe(true);
  }, 180_000);
});

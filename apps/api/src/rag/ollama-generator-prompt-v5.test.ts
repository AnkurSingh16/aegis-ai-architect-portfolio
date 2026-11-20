import { describe, expect, it, vi } from 'vitest';
import { createOllamaGenerator } from './ollama-generator.js';

const evidence = [{ sourceId: 'SYNTHETIC-NORTH-MFA-GUIDANCE', text: 'Confirm the test factor is available.', score: 0.8 }];

async function systemPromptFor(version: 'v3' | 'v4' | 'v5'): Promise<string> {
  const fetchImpl = vi.fn<(url: string, init: { body: string }) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>>(
    async () => ({ ok: true, status: 200, json: async () => ({ response: 'x' }) }));
  await createOllamaGenerator(fetchImpl, version)({ question: 'q', query: 'q', evidence, feedback: [] });
  return (JSON.parse(fetchImpl.mock.calls[0]![1].body) as { system: string }).system;
}

describe('generator prompt version 5', () => {
  it('keeps every version 3 rule, adds the answer-first rule, and contains no layout example', async () => {
    const v3 = await systemPromptFor('v3');
    const v5 = await systemPromptFor('v5');
    expect(v5.startsWith(v3)).toBe(true);
    expect(v5).toContain('Begin with the answer to the question, in your own words');
    expect(v5).not.toContain('EXAMPLE-ID');
    expect(v5).not.toContain('answer text here');
  });

  it('version 4 still carries the example, so the recorded v4 runs stay reproducible', async () => {
    expect(await systemPromptFor('v4')).toContain('EXAMPLE-ID');
  });
});

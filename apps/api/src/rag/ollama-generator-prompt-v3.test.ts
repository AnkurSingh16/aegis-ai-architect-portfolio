import { describe, expect, it, vi } from 'vitest';
import { createOllamaGenerator } from './ollama-generator.js';

const evidence = [{ sourceId: 'SYNTHETIC-NORTH-MFA-GUIDANCE', text: 'Confirm the test factor is available.', score: 0.8 }];

async function systemPromptFor(version: 'v2' | 'v3'): Promise<string> {
  const fetchImpl = vi.fn<(url: string, init: { body: string }) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>>(
    async () => ({ ok: true, status: 200, json: async () => ({ response: 'x' }) }));
  await createOllamaGenerator(fetchImpl, version)({ question: 'q', query: 'q', evidence, feedback: [] });
  return (JSON.parse(fetchImpl.mock.calls[0]![1].body) as { system: string }).system;
}

describe('generator prompt version 3', () => {
  it('keeps every version 2 rule and adds the rule against extra citations', async () => {
    const v2 = await systemPromptFor('v2');
    const v3 = await systemPromptFor('v3');
    expect(v3.startsWith(v2)).toBe(true);
    expect(v3).toContain('Cite only the sources that directly support a statement.');
    expect(v3).toContain('Do not add a source because it is related to the question.');
  });
});

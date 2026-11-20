import { describe, expect, it, vi } from 'vitest';
import { createOllamaGenerator } from './ollama-generator.js';

const evidence = [{ sourceId: 'SYNTHETIC-NORTH-MFA-GUIDANCE', text: 'Confirm the test factor is available.', score: 0.8 }];

async function systemPromptFor(version: 'v3' | 'v4'): Promise<string> {
  const fetchImpl = vi.fn<(url: string, init: { body: string }) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>>(
    async () => ({ ok: true, status: 200, json: async () => ({ response: 'x' }) }));
  await createOllamaGenerator(fetchImpl, version)({ question: 'q', query: 'q', evidence, feedback: [] });
  return (JSON.parse(fetchImpl.mock.calls[0]![1].body) as { system: string }).system;
}

describe('generator prompt version 4', () => {
  it('keeps every version 3 rule and adds the layout example with a placeholder id', async () => {
    const v3 = await systemPromptFor('v3');
    const v4 = await systemPromptFor('v4');
    expect(v4.startsWith(v3)).toBe(true);
    expect(v4).toContain('Sources: [EXAMPLE-ID]');
    expect(v4).toContain('EXAMPLE-ID is a placeholder and is never a valid source.');
  });
});

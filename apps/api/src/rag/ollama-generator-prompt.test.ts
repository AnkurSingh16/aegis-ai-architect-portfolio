import { describe, expect, it, vi } from 'vitest';
import { createOllamaGenerator } from './ollama-generator.js';

const evidence = [{ sourceId: 'SYNTHETIC-NORTH-MFA-GUIDANCE', text: 'Confirm the test factor is available.', score: 0.8 }];

async function systemPromptFor(version?: 'v1' | 'v2'): Promise<string> {
  const fetchImpl = vi.fn<(url: string, init: { body: string }) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>>(
    async () => ({ ok: true, status: 200, json: async () => ({ response: 'x' }) }));
  const generate = version ? createOllamaGenerator(fetchImpl, version) : createOllamaGenerator(fetchImpl);
  await generate({ question: 'q', query: 'q', evidence, feedback: [] });
  const body = JSON.parse(fetchImpl.mock.calls[0]![1].body) as { system: string };
  return body.system;
}

describe('generator prompt versions', () => {
  it('version 1 is the recorded prompt and has no Sources line rule', async () => {
    const system = await systemPromptFor('v1');
    expect(system).not.toContain('Sources:');
    expect(system).toContain('INSUFFICIENT_EVIDENCE');
  });

  it('defaults to version 1, so the recorded run stays reproducible', async () => {
    expect(await systemPromptFor()).toBe(await systemPromptFor('v1'));
  });

  it('version 2 keeps every version 1 rule and adds the final Sources line rule', async () => {
    const v1 = await systemPromptFor('v1');
    const v2 = await systemPromptFor('v2');
    expect(v2.startsWith(v1)).toBe(true);
    expect(v2).toContain('Sources: [SOURCE-ID]');
    expect(v2).toContain('An answer without that final Sources line is invalid.');
  });
});

import { describe, expect, it, vi } from 'vitest';
import { createOllamaReformulator, REFORMULATOR_MODEL } from './ollama-reformulator.js';
import { GenerationError } from './ollama-generator.js';

function fakeFetch(response: { ok: boolean; status: number; body: unknown } | Error) {
  return vi.fn<(url: string, init: { body: string }) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>>(async () => {
    if (response instanceof Error) throw response;
    return { ok: response.ok, status: response.status, json: async () => response.body };
  });
}

const input = { question: 'How do I confirm a second factor?', query: 'q', feedback: ['insufficient_evidence'] };

describe('createOllamaReformulator', () => {
  it('posts a deterministic, non-streaming request with the pinned model and returns one line', async () => {
    const fetchImpl = fakeFetch({ ok: true, status: 200, body: { response: '"multi-factor test factor check"\nextra line' } });
    const reformulate = createOllamaReformulator(fetchImpl);
    expect(await reformulate(input)).toBe('multi-factor test factor check');
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe('http://127.0.0.1:11434/api/generate');
    expect(JSON.parse(init.body)).toMatchObject({ model: REFORMULATOR_MODEL, stream: false, options: { temperature: 0 } });
  });

  it('returns null for an empty or overlong output', async () => {
    expect(await createOllamaReformulator(fakeFetch({ ok: true, status: 200, body: { response: '   ' } }))(input)).toBeNull();
    expect(await createOllamaReformulator(fakeFetch({ ok: true, status: 200, body: { response: 'x'.repeat(300) } }))(input)).toBeNull();
  });

  it('throws a GenerationError on HTTP error, network failure or an unexpected shape', async () => {
    await expect(createOllamaReformulator(fakeFetch({ ok: false, status: 503, body: {} }))(input))
      .rejects.toThrow(GenerationError);
    await expect(createOllamaReformulator(fakeFetch(new Error('ECONNREFUSED')))(input))
      .rejects.toThrow('reformulation service unavailable');
    await expect(createOllamaReformulator(fakeFetch({ ok: true, status: 200, body: { done: true } }))(input))
      .rejects.toThrow('unexpected reformulation shape');
  });
});

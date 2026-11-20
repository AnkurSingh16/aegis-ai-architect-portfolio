import { describe, expect, it, vi } from 'vitest';
import { buildPrompt, createOllamaGenerator, GENERATOR_MODEL, GenerationError } from './ollama-generator.js';

const evidence = [
  { sourceId: 'SYNTHETIC-NORTH-MFA-GUIDANCE', text: 'Confirm the test factor is available.', score: 0.8 },
  { sourceId: 'SYNTHETIC-NORTH-LOGIN-INCIDENT', text: 'Record the time window.', score: 0.75 },
];

function fakeFetch(response: { ok: boolean; status: number; body: unknown } | Error) {
  return vi.fn<(url: string, init: { body: string }) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>>(async () => {
    if (response instanceof Error) throw response;
    return { ok: response.ok, status: response.status, json: async () => response.body };
  });
}

describe('buildPrompt', () => {
  it('lists each evidence item with its source id, then the question', () => {
    const prompt = buildPrompt({ question: 'What confirms a factor?', query: 'q', evidence, feedback: [] });
    expect(prompt).toContain('[SYNTHETIC-NORTH-MFA-GUIDANCE]\nConfirm the test factor is available.');
    expect(prompt).toContain('[SYNTHETIC-NORTH-LOGIN-INCIDENT]');
    expect(prompt.indexOf('Question: What confirms a factor?')).toBeGreaterThan(prompt.indexOf('[SYNTHETIC-NORTH-LOGIN-INCIDENT]'));
  });

  it('passes feedback as problem names only', () => {
    const prompt = buildPrompt({ question: 'q', query: 'q', evidence, feedback: ['unknown_citation'] });
    expect(prompt).toContain('previous attempt had these problems: unknown_citation');
  });

  it('caps the number of evidence items and the length of each text', () => {
    const many = Array.from({ length: 8 }, (_, i) => ({ sourceId: `SYNTHETIC-NORTH-X${i}`, text: 'x'.repeat(5000), score: 0.9 }));
    const prompt = buildPrompt({ question: 'q', query: 'q', evidence: many, feedback: [] });
    expect(prompt).toContain('SYNTHETIC-NORTH-X4');
    expect(prompt).not.toContain('SYNTHETIC-NORTH-X5');
    expect(prompt).not.toContain('x'.repeat(2001));
  });

  it('refuses to build a prompt with no evidence', () => {
    expect(() => buildPrompt({ question: 'q', query: 'q', evidence: [], feedback: [] })).toThrow(GenerationError);
  });
});

describe('createOllamaGenerator', () => {
  it('posts a non-streaming, deterministic request to loopback Ollama with the pinned model', async () => {
    const fetchImpl = fakeFetch({ ok: true, status: 200, body: { response: '  Confirm the test factor [SYNTHETIC-NORTH-MFA-GUIDANCE].  ' } });
    const generate = createOllamaGenerator(fetchImpl);
    const answer = await generate({ question: 'What confirms a factor?', query: 'q', evidence, feedback: [] });
    expect(answer).toBe('Confirm the test factor [SYNTHETIC-NORTH-MFA-GUIDANCE].');
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe('http://127.0.0.1:11434/api/generate');
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body).toMatchObject({ model: GENERATOR_MODEL, stream: false, options: { temperature: 0 } });
    expect(String(body.system)).toContain('INSUFFICIENT_EVIDENCE');
  });

  it('turns an HTTP error into a GenerationError without the response body', async () => {
    const generate = createOllamaGenerator(fakeFetch({ ok: false, status: 500, body: { error: 'secret detail' } }));
    const failure = generate({ question: 'q', query: 'q', evidence, feedback: [] });
    await expect(failure).rejects.toThrow('generation service returned HTTP 500');
    await expect(failure).rejects.not.toThrow('secret detail');
  });

  it('turns a network failure into a GenerationError', async () => {
    const generate = createOllamaGenerator(fakeFetch(new Error('connect ECONNREFUSED')));
    await expect(generate({ question: 'q', query: 'q', evidence, feedback: [] })).rejects.toThrow('generation service unavailable');
  });

  it('rejects a response without a text field', async () => {
    const generate = createOllamaGenerator(fakeFetch({ ok: true, status: 200, body: { done: true } }));
    await expect(generate({ question: 'q', query: 'q', evidence, feedback: [] })).rejects.toThrow('unexpected generation shape');
  });
});

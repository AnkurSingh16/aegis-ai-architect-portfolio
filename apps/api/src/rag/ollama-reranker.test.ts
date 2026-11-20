import { describe, expect, it, vi } from 'vitest';
import { buildRerankPrompt, createOllamaReranker, moveSourceFirst, RERANKER_PROMPT_VERSION } from './ollama-reranker.js';
import type { Evidence } from './self-correcting-answer.js';

const items: Evidence[] = [
  { sourceId: 'SYNTHETIC-NORTH-ACCOUNT-RECOVERY', text: 'Recovery steps.', score: 0.69 },
  { sourceId: 'SYNTHETIC-NORTH-MFA-GUIDANCE', text: 'Factor checks.', score: 0.67 },
  { sourceId: 'SYNTHETIC-NORTH-MFA-GUIDANCE', text: 'Second MFA chunk.', score: 0.6 },
];

function fetchReplying(response: string) {
  return vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ response }) }));
}

describe('moveSourceFirst', () => {
  it('moves the first item of the chosen source to the front and keeps the rest in order', () => {
    const moved = moveSourceFirst(items, 'SYNTHETIC-NORTH-MFA-GUIDANCE');
    expect(moved.map((item) => item.text)).toEqual(['Factor checks.', 'Recovery steps.', 'Second MFA chunk.']);
    expect(moved.map((item) => item.score)).toEqual([0.67, 0.69, 0.6]);
  });

  it('leaves the order unchanged when the chosen source is already first or absent', () => {
    expect(moveSourceFirst(items, 'SYNTHETIC-NORTH-ACCOUNT-RECOVERY')).toEqual(items);
    expect(moveSourceFirst(items, 'SYNTHETIC-NORTH-NOT-THERE')).toEqual(items);
  });
});

describe('createOllamaReranker', () => {
  it('moves the chosen source first and reports moved', async () => {
    const result = await createOllamaReranker(fetchReplying('SYNTHETIC-NORTH-MFA-GUIDANCE'))('question', items);
    expect(result.outcome).toBe('moved');
    expect(result.order[0]!.sourceId).toBe('SYNTHETIC-NORTH-MFA-GUIDANCE');
  });

  it('accepts the id in square brackets', async () => {
    const result = await createOllamaReranker(fetchReplying('[SYNTHETIC-NORTH-MFA-GUIDANCE]'))('question', items);
    expect(result.outcome).toBe('moved');
  });

  it('keeps the order and reports kept when the model picks the source already first', async () => {
    const result = await createOllamaReranker(fetchReplying('SYNTHETIC-NORTH-ACCOUNT-RECOVERY'))('question', items);
    expect(result).toEqual({ order: items, outcome: 'kept' });
  });

  it('keeps the order and reports unparsed when the reply is not a retrieved id', async () => {
    const result = await createOllamaReranker(fetchReplying('I think the MFA guidance is best.'))('question', items);
    expect(result).toEqual({ order: items, outcome: 'unparsed' });
  });

  it('keeps the order and reports failed when the service is unavailable', async () => {
    const down = vi.fn(async () => { throw new Error('connection refused'); });
    const result = await createOllamaReranker(down)('question', items);
    expect(result).toEqual({ order: items, outcome: 'failed' });
  });

  it('does not call the model for fewer than two items', async () => {
    const fetchImpl = fetchReplying('x');
    const result = await createOllamaReranker(fetchImpl)('question', [items[0]!]);
    expect(result.outcome).toBe('kept');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('pins the prompt version and sends only retrieved text, with temperature zero', async () => {
    const fetchImpl = fetchReplying('SYNTHETIC-NORTH-MFA-GUIDANCE');
    await createOllamaReranker(fetchImpl)('question', items);
    const init = (fetchImpl.mock.calls[0] as unknown as [string, { body: string }])[1];
    const body = JSON.parse(init.body) as { model: string; options: { temperature: number }; prompt: string };
    expect(body.options.temperature).toBe(0);
    expect(body.model).toBe('qwen2.5:3b-instruct');
    expect(body.prompt).toBe(buildRerankPrompt('question', items));
    expect(RERANKER_PROMPT_VERSION).toBe('rr1');
  });
});

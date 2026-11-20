import { GENERATOR_MODEL, GENERATOR_MODEL_DIGEST, GenerationError } from './ollama-generator.js';
import type { SelfCorrectionDeps } from './self-correcting-answer.js';

/**
 * Local query reformulator for the answer loop. Loopback Ollama only, the same pinned chat model as the generator,
 * deterministic decoding, one short line out. It returns null when it has nothing usable, which the loop treats as no
 * reformulation. The prompt is fixed and versioned with docs/DEV-C4-REFORMULATION.md.
 */
export const REFORMULATOR_PROMPT_VERSION = 'r1' as const;
export { GENERATOR_MODEL as REFORMULATOR_MODEL, GENERATOR_MODEL_DIGEST as REFORMULATOR_MODEL_DIGEST };
const BASE_URL = 'http://127.0.0.1:11434';
const TIMEOUT_MS = 60_000;
const MAX_OUTPUT_CHARS = 200;

const SYSTEM_PROMPT = [
  'Rewrite the user question as one short search query of at most fifteen words.',
  'Use the plain words a support procedure document would use for the same topic.',
  'Output only the query on a single line, with no quotes, no explanation and no answer.',
].join(' ');

type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal }) =>
  Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export type Reformulator = SelfCorrectionDeps['reformulate'];

export function createOllamaReformulator(fetchImpl: FetchLike = fetch as unknown as FetchLike): Reformulator {
  return async ({ question }) => {
    let response;
    try {
      response = await fetchImpl(`${BASE_URL}/api/generate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: GENERATOR_MODEL,
          system: SYSTEM_PROMPT,
          prompt: question.slice(0, 1000),
          stream: false,
          options: { temperature: 0, num_predict: 48 },
        }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch {
      throw new GenerationError('reformulation service unavailable');
    }
    if (!response.ok) throw new GenerationError(`reformulation service returned HTTP ${response.status}`);
    const body = await response.json() as { response?: unknown };
    if (typeof body.response !== 'string') throw new GenerationError('unexpected reformulation shape');
    const line = body.response.trim().split('\n')[0]?.trim().replace(/^["']|["']$/g, '').trim() ?? '';
    if (line.length === 0 || line.length > MAX_OUTPUT_CHARS) return null;
    return line;
  };
}

/**
 * Local embedding client. Loopback Ollama only, one fixed model, bounded batch and timeout.
 * Development use: the model is not a protected exploratory model and nothing here calls a cloud provider.
 */
export const EMBEDDING_MODEL = 'nomic-embed-text' as const;
export const EMBEDDING_MODEL_DIGEST = '0a109f422b47e3a30ba2b10eca18548e944e8a23073ee3f3e947efcf3c45e59f';
export const EMBEDDING_DIMENSIONS = 768;
const BASE_URL = 'http://127.0.0.1:11434';
const MAX_BATCH = 8;
const MAX_INPUT_CHARS = 8192;
const TIMEOUT_MS = 30_000;

export class EmbeddingError extends Error {
  readonly name = 'EmbeddingError';
}

export type EmbeddingKind = 'search_document' | 'search_query';

type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal }) =>
  Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export async function embedTexts(texts: readonly string[], kind: EmbeddingKind, fetchImpl: FetchLike = fetch as unknown as FetchLike): Promise<number[][]> {
  if (texts.length === 0 || texts.length > MAX_BATCH) throw new EmbeddingError('batch size out of bounds');
  for (const text of texts) {
    if (text.length === 0 || text.length > MAX_INPUT_CHARS) throw new EmbeddingError('input length out of bounds');
  }
  const prefixed = texts.map((text) => `${kind}: ${text}`);
  let response;
  try {
    response = await fetchImpl(`${BASE_URL}/api/embed`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: EMBEDDING_MODEL, input: prefixed }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw new EmbeddingError('embedding service unavailable');
  }
  if (!response.ok) throw new EmbeddingError(`embedding service returned HTTP ${response.status}`);
  const body = await response.json() as { embeddings?: unknown };
  if (!Array.isArray(body.embeddings) || body.embeddings.length !== texts.length) throw new EmbeddingError('unexpected embedding count');
  return body.embeddings.map((vector) => {
    if (!Array.isArray(vector) || vector.length !== EMBEDDING_DIMENSIONS || !vector.every((x) => typeof x === 'number' && Number.isFinite(x))) {
      throw new EmbeddingError('unexpected embedding shape');
    }
    return vector as number[];
  });
}

/** pgvector literal, e.g. [0.1,0.2]. Values are validated numbers, so no SQL is built from them. */
export function toVectorLiteral(vector: readonly number[]): string {
  if (vector.length !== EMBEDDING_DIMENSIONS || !vector.every(Number.isFinite)) throw new EmbeddingError('invalid vector');
  return `[${vector.join(',')}]`;
}

import type { StoredCase } from '../storage/models.js';
import { buildAnalysisPrompt, createAnalysisResult, parseAnalysisOutput, type AnalysisResult } from './analysis.js';

const endpoint = 'http://127.0.0.1:11434/api/generate';
const maxResponseBytes = 8192;
const maxPromptBytes = 4096;
const allowedModel = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;

export class AnalysisUnavailableError extends Error {
  constructor() { super('AI analysis is unavailable. Check the local development provider and retry.'); }
}
export class AnalysisDisabledError extends Error {
  constructor() { super('AI analysis is disabled for this development server.'); }
}
export interface AnalysisProvider { analyze(stored: StoredCase, signal: AbortSignal): Promise<AnalysisResult> }
export interface OllamaConfig { model: string; timeoutMs: number; maxConcurrent: number }

function proxyModeEnabled(env: NodeJS.ProcessEnv, execArgs: readonly string[]): boolean {
  const proxyVariables = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy'];
  const nodeOptions = env.NODE_OPTIONS ?? '';
  return proxyVariables.some((key) => Boolean(env[key])) || env.NODE_USE_ENV_PROXY === '1' ||
    execArgs.some((argument) => argument === '--use-env-proxy' || argument.startsWith('--use-env-proxy=')) ||
    /(?:^|\s)--use-env-proxy(?:=\S+)?(?:\s|$)/.test(nodeOptions);
}

export function resolveOllamaConfig(env: NodeJS.ProcessEnv, nodeEnv = env.NODE_ENV,
  execArgs: readonly string[] = process.execArgv): OllamaConfig | undefined {
  const enabled = env.AEGIS_AI_ENABLED;
  if (enabled === undefined || enabled === 'false') return undefined;
  if (enabled !== 'true' || nodeEnv === 'production' || nodeEnv !== 'development') {
    throw new Error('AI analysis configuration is invalid or unavailable outside local development.');
  }
  if (proxyModeEnabled(env, execArgs)) throw new Error('AI analysis requires direct loopback network access without proxy configuration.');
  const model = env.AEGIS_OLLAMA_MODEL;
  if (!model || !allowedModel.test(model)) throw new Error('AI analysis configuration is invalid or unavailable outside local development.');
  const timeoutMs = env.AEGIS_AI_TIMEOUT_MS === undefined ? 15000 : Number(env.AEGIS_AI_TIMEOUT_MS);
  const maxConcurrent = env.AEGIS_AI_MAX_CONCURRENT === undefined ? 1 : Number(env.AEGIS_AI_MAX_CONCURRENT);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 30000 ||
      !Number.isSafeInteger(maxConcurrent) || maxConcurrent < 1 || maxConcurrent > 2) {
    throw new Error('AI analysis configuration is invalid or unavailable outside local development.');
  }
  return { model, timeoutMs, maxConcurrent };
}

async function readBoundedBody(response: Response): Promise<string> {
  const declared = response.headers.get('content-length');
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > maxResponseBytes)) throw new AnalysisUnavailableError();
  if (!response.body) throw new AnalysisUnavailableError();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxResponseBytes) {
        await reader.cancel();
        throw new AnalysisUnavailableError();
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, size));
}

function optionalTokenCount(value: unknown): number | null {
  if (value === undefined) return null;
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new AnalysisUnavailableError();
  return value as number;
}

export function createOllamaProvider(config: OllamaConfig, options: {
  fetchImpl?: typeof fetch;
  log?: (event: Record<string, string | number | null>) => void;
  now?: () => number;
} = {}): AnalysisProvider {
  let active = 0;
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now;
  const log = options.log ?? ((event) => console.info(JSON.stringify(event)));
  return {
    async analyze(stored, signal) {
      if (active >= config.maxConcurrent) throw new AnalysisUnavailableError();
      active++;
      const started = now();
      const controller = new AbortController();
      const cancel = () => controller.abort();
      const timeout = setTimeout(cancel, config.timeoutMs);
      signal.addEventListener('abort', cancel, { once: true });
      try {
        if (signal.aborted) throw new AnalysisUnavailableError();
        const prompt = buildAnalysisPrompt(stored);
        if (Buffer.byteLength(prompt) > maxPromptBytes) throw new AnalysisUnavailableError();
        const response = await fetchImpl(endpoint, {
          method: 'POST', redirect: 'error', signal: controller.signal,
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify({ model: config.model, prompt, stream: false, format: 'json',
            options: { temperature: 0.1, num_predict: 256 }, keep_alive: '5m' }),
        });
        if (!response.ok) throw new AnalysisUnavailableError();
        const raw = await readBoundedBody(response);
        let envelope: unknown;
        try { envelope = JSON.parse(raw); } catch { throw new AnalysisUnavailableError(); }
        if (typeof envelope !== 'object' || envelope === null || Array.isArray(envelope)) throw new AnalysisUnavailableError();
        const result = envelope as Record<string, unknown>;
        if (result.done !== true || result.model !== config.model || typeof result.response !== 'string' ||
            Buffer.byteLength(result.response) > 4096) throw new AnalysisUnavailableError();
        let modelJson: unknown;
        try { modelJson = JSON.parse(result.response); } catch { throw new AnalysisUnavailableError(); }
        const output = parseAnalysisOutput(modelJson);
        const metrics = { latencyMs: Math.max(0, Math.round(now() - started)),
          promptTokens: optionalTokenCount(result.prompt_eval_count), generatedTokens: optionalTokenCount(result.eval_count) };
        log({ event: 'ai_case_analysis', provider: 'ollama', model: config.model, outcome: 'success', ...metrics });
        return createAnalysisResult(stored.id, output, config.model, metrics);
      } catch {
        if (!signal.aborted) log({ event: 'ai_case_analysis', provider: 'ollama', model: config.model,
          outcome: 'failure', latencyMs: Math.max(0, Math.round(now() - started)), promptTokens: null, generatedTokens: null });
        throw new AnalysisUnavailableError();
      } finally {
        clearTimeout(timeout);
        signal.removeEventListener('abort', cancel);
        active--;
      }
    },
  };
}

export const ollamaEndpointForTests = endpoint;

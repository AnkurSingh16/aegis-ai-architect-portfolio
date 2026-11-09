import type { StoredCase } from '../storage/models.js';
import { analysisOutputFailureReason, analysisOutputJsonSchema, AnalysisOutputValidationError, buildAnalysisPrompt, createAnalysisResult, parseAnalysisOutput,
  type AnalysisOutputFailureReason, type AnalysisResult, type EvidenceReferenceFailureReason } from './analysis.js';

const endpoint = 'http://127.0.0.1:11434/api/generate';
const maxResponseBytes = 8192;
const maxPromptBytes = 4096;
const allowedModel = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;

type FailureStage = 'provider_connection' | 'provider_http' | 'response_size' | 'response_decode' |
  'response_envelope' | 'model_json_parse' | 'output_schema' | 'generation_timeout' |
  'request_cancelled' | 'input_validation' | 'unknown';
type FailureMetadata = { httpStatus?: number; responseBytes?: number; schemaReason?: AnalysisOutputFailureReason;
  evidenceReason?: EvidenceReferenceFailureReason };

class ProviderFailure extends Error {
  constructor(readonly stage: FailureStage, readonly metadata: FailureMetadata = {}) { super(); }
}

export class AnalysisUnavailableError extends Error {
  constructor() { super('AI analysis is unavailable. Check the local development provider and retry.'); }
}
export class AnalysisDisabledError extends Error {
  constructor() { super('AI analysis is disabled for this development server.'); }
}
export interface AnalysisProvider { analyze(stored: StoredCase, signal: AbortSignal, correlationId?: string): Promise<AnalysisResult> }
export interface OllamaConfig { model: string; timeoutMs: number; maxConcurrent: number }

const canonicalUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
function safeCorrelationId(value: unknown): string | undefined {
  return typeof value === 'string' && canonicalUuid.test(value) ? value : undefined;
}

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

async function readBoundedBody(response: Response): Promise<{ text: string; responseBytes: number }> {
  const declared = response.headers.get('content-length');
  if (declared !== null && !/^\d+$/.test(declared)) throw new ProviderFailure('response_envelope');
  if (declared !== null && Number(declared) > maxResponseBytes) {
    throw new ProviderFailure('response_size', { responseBytes: maxResponseBytes + 1 });
  }
  if (!response.body) throw new ProviderFailure('response_decode');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxResponseBytes) {
        try { await reader.cancel(); } catch { /* Preserve the bounded-size failure. */ }
        throw new ProviderFailure('response_size', { responseBytes: maxResponseBytes + 1 });
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof ProviderFailure) throw error;
    throw new ProviderFailure('response_decode', { responseBytes: Math.min(size, maxResponseBytes + 1) });
  } finally { reader.releaseLock(); }
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, size)), responseBytes: size };
  } catch {
    throw new ProviderFailure('response_decode', { responseBytes: size });
  }
}

function optionalTokenCount(value: unknown): number | null {
  if (value === undefined) return null;
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new ProviderFailure('response_envelope');
  return value as number;
}

function safeHttpStatus(value: number): number | undefined {
  return Number.isSafeInteger(value) && value >= 100 && value <= 599 ? value : undefined;
}

function logSafely(log: (event: Record<string, string | number | null>) => void,
  event: Record<string, string | number | null>): void {
  try { log(event); } catch { /* Diagnostics must never change the analysis outcome. */ }
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
    async analyze(stored, signal, correlationId) {
      if (active >= config.maxConcurrent) throw new AnalysisUnavailableError();
      active++;
      const safeId = safeCorrelationId(correlationId);
      const started = now();
      const controller = new AbortController();
      let abortCause: 'generation_timeout' | 'request_cancelled' | undefined;
      const abort = (cause: 'generation_timeout' | 'request_cancelled') => {
        if (!controller.signal.aborted) {
          abortCause = cause;
          controller.abort();
        }
      };
      const throwIfAborted = () => {
        if (abortCause) throw new ProviderFailure(abortCause);
      };
      const cancel = () => abort('request_cancelled');
      const timeout = setTimeout(() => abort('generation_timeout'), config.timeoutMs);
      signal.addEventListener('abort', cancel, { once: true });
      try {
        if (signal.aborted) cancel();
        if (abortCause) throw new ProviderFailure(abortCause);
        let prompt: string;
        try { prompt = buildAnalysisPrompt(stored); }
        catch { throw new ProviderFailure('input_validation'); }
        if (Buffer.byteLength(prompt) > maxPromptBytes) throw new ProviderFailure('input_validation');
        let response: Response;
        try {
          response = await fetchImpl(endpoint, {
            method: 'POST', redirect: 'error', signal: controller.signal,
            headers: { 'content-type': 'application/json', accept: 'application/json' },
            body: JSON.stringify({ model: config.model, prompt, stream: false, format: analysisOutputJsonSchema,
              options: { temperature: 0.1, num_predict: 256 }, keep_alive: '5m' }),
          });
        } catch {
          if (abortCause) throw new ProviderFailure(abortCause);
          throw new ProviderFailure('provider_connection');
        }
        throwIfAborted();
        if (!response.ok) throw new ProviderFailure('provider_http', { httpStatus: safeHttpStatus(response.status) });
        const body = await readBoundedBody(response);
        throwIfAborted();
        let envelope: unknown;
        try { envelope = JSON.parse(body.text); }
        catch { throw new ProviderFailure('response_envelope', { responseBytes: body.responseBytes }); }
        if (typeof envelope !== 'object' || envelope === null || Array.isArray(envelope)) {
          throw new ProviderFailure('response_envelope', { responseBytes: body.responseBytes });
        }
        const result = envelope as Record<string, unknown>;
        if (result.done !== true || result.model !== config.model || typeof result.response !== 'string' ||
            Buffer.byteLength(result.response) > 4096) {
          throw new ProviderFailure('response_envelope', { responseBytes: body.responseBytes });
        }
        let modelJson: unknown;
        try { modelJson = JSON.parse(result.response); }
        catch { throw new ProviderFailure('model_json_parse', { responseBytes: body.responseBytes }); }
        let output: ReturnType<typeof parseAnalysisOutput>;
        try { output = parseAnalysisOutput(modelJson); }
        catch (error) {
          let evidenceReason: EvidenceReferenceFailureReason | undefined;
          try {
            if (error instanceof AnalysisOutputValidationError && error.reason === 'invalid_evidence_references') {
              evidenceReason = error.evidenceReason;
            }
          } catch { /* Omit malformed diagnostic metadata and preserve the generic schema failure. */ }
          throw new ProviderFailure('output_schema', {
            responseBytes: body.responseBytes, schemaReason: analysisOutputFailureReason(error),
            ...(evidenceReason === undefined ? {} : { evidenceReason }),
          });
        }
        const metrics = { latencyMs: Math.max(0, Math.round(now() - started)),
          promptTokens: optionalTokenCount(result.prompt_eval_count), generatedTokens: optionalTokenCount(result.eval_count) };
        const analysis = createAnalysisResult(stored.id, output, config.model, metrics);
        throwIfAborted();
        logSafely(log, { event: 'ai_case_analysis', provider: 'ollama', model: config.model, outcome: 'success', ...metrics,
          ...(safeId === undefined ? {} : { correlationId: safeId }) });
        return analysis;
      } catch (error) {
        const failure = error instanceof ProviderFailure ? error : new ProviderFailure('unknown');
        const failureStage = abortCause ?? failure.stage;
        const event: Record<string, string | number | null> = {
          event: 'ai_case_analysis', provider: 'ollama', outcome: 'failure', failureStage,
          latencyMs: Math.max(0, Math.round(now() - started)),
          ...(safeId === undefined ? {} : { correlationId: safeId }),
        };
        if (failure.metadata.httpStatus !== undefined) event.httpStatus = failure.metadata.httpStatus;
        if (failure.metadata.responseBytes !== undefined) event.responseBytes = failure.metadata.responseBytes;
        if (failureStage === 'output_schema') {
          event.schemaReason = failure.metadata.schemaReason ?? 'unclassified';
          if (failure.metadata.schemaReason === 'invalid_evidence_references' && failure.metadata.evidenceReason !== undefined) {
            event.evidenceReason = failure.metadata.evidenceReason;
          }
        }
        logSafely(log, event);
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

import { categories, priorities, suggestedTeams } from '../contracts/triage.js';
import { recommendedActions, uncertaintyLevels } from './analysis.js';

export const groundedAnalysisSchema = {
  type: 'object',
  required: ['groundingState', 'category', 'priority', 'recommendedTeam', 'rationale', 'nextAction', 'citations', 'confidence', 'uncertainty', 'humanReviewRequired'],
  additionalProperties: false,
  properties: {
    groundingState: { type: 'string', enum: ['SUPPORTED', 'INSUFFICIENT_EVIDENCE'] },
    category: { type: ['string', 'null'], enum: [...categories, null] },
    priority: { type: ['string', 'null'], enum: [...priorities, null] },
    recommendedTeam: { type: ['string', 'null'], enum: [...suggestedTeams, null] },
    rationale: { type: ['string', 'null'], minLength: 1, maxLength: 700 },
    nextAction: { type: ['string', 'null'], enum: [...recommendedActions, null] },
    citations: { type: 'array', maxItems: 5, items: { type: 'string' } },
    confidence: { type: ['number', 'null'], minimum: 0, maximum: 1 },
    uncertainty: { type: ['string', 'null'], enum: [...uncertaintyLevels, null] },
    humanReviewRequired: { type: 'boolean', enum: [true] },
  },
} as const;

export type GroundedProviderOutput = {
  groundingState: 'SUPPORTED';
  category: typeof categories[number];
  priority: typeof priorities[number];
  recommendedTeam: typeof suggestedTeams[number];
  rationale: string;
  nextAction: typeof recommendedActions[number];
  citations: string[];
  confidence: number;
  uncertainty: typeof uncertaintyLevels[number];
  humanReviewRequired: true;
} | {
  groundingState: 'INSUFFICIENT_EVIDENCE'; category: null; priority: null; recommendedTeam: null; rationale: null;
  nextAction: null; citations: []; confidence: null; uncertainty: 'high'; humanReviewRequired: true;
};

export interface GroundedSource {
  citationId: string;
  title: string;
  sourceIdentity: string;
  version: number;
  position: number;
  content: string;
}

export interface GroundedAnalysisProvider {
  readonly model: string;
  analyze(input: { caseStatus: string; caseType: string; sources: readonly GroundedSource[] }, signal: AbortSignal,
    correlationId: string): Promise<{ output: GroundedProviderOutput; metrics: { latencyMs: number; promptTokens: number | null; generatedTokens: number | null } }>;
}

export class GroundedOutputError extends Error {
  constructor(readonly reason: 'invalid_output' | 'invalid_citations') { super('Grounded analysis output is invalid.'); }
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function safeRationale(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 700 &&
    !/<\/?[a-z][^>]*>|https?:\/\/|\b(?:bearer|api[_ -]?key|password|secret)\b|\bignore (?:all )?(?:prior|previous|system)|\bignore human review|\bexecute\b|\bescalate\b|\bsend (?:a )?(?:customer )?message|\bchange (?:the )?case status|\breveal (?:the )?(?:system )?prompt\b/i.test(value);
}

const citationUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Keeps generation output separate from authoritative request-scoped citation resolution. */
export function parseGroundedProviderOutput(value: unknown, sources: readonly GroundedSource[]): GroundedProviderOutput {
  if (!record(value)) throw new GroundedOutputError('invalid_output');
  const keys = ['groundingState', 'category', 'priority', 'recommendedTeam', 'rationale', 'nextAction', 'citations', 'confidence', 'uncertainty', 'humanReviewRequired'];
  if (Object.keys(value).length !== keys.length || !keys.every((key) => Object.hasOwn(value, key)) || value.humanReviewRequired !== true) {
    throw new GroundedOutputError('invalid_output');
  }
  if (value.groundingState === 'INSUFFICIENT_EVIDENCE' && value.category === null && value.priority === null &&
      value.recommendedTeam === null && value.rationale === null && value.nextAction === null && Array.isArray(value.citations) &&
      value.citations.length === 0 && value.confidence === null && value.uncertainty === 'high') {
    return value as GroundedProviderOutput;
  }
  if (value.groundingState !== 'SUPPORTED' ||
      !categories.includes(value.category as typeof categories[number]) || !priorities.includes(value.priority as typeof priorities[number]) ||
      !suggestedTeams.includes(value.recommendedTeam as typeof suggestedTeams[number]) || !recommendedActions.includes(value.nextAction as typeof recommendedActions[number]) ||
      !safeRationale(value.rationale) || !Number.isFinite(value.confidence) || typeof value.confidence !== 'number' || value.confidence < 0 || value.confidence > 1 ||
      !uncertaintyLevels.includes(value.uncertainty as typeof uncertaintyLevels[number]) || value.humanReviewRequired !== true) {
    throw new GroundedOutputError('invalid_output');
  }
  if (!Array.isArray(value.citations) || value.citations.length < 1 || value.citations.length > 5 ||
      !value.citations.every((item) => typeof item === 'string' && citationUuid.test(item))) throw new GroundedOutputError('invalid_citations');
  const allowed = new Set(sources.map((source) => source.citationId));
  if (new Set(value.citations).size !== value.citations.length || value.citations.some((citation) => !allowed.has(citation))) {
    throw new GroundedOutputError('invalid_citations');
  }
  return value as GroundedProviderOutput;
}

export type GroundedAnalysisResult =
  | { groundingState: 'SUPPORTED'; caseId: string; category: typeof categories[number]; priority: typeof priorities[number];
      recommendedTeam: typeof suggestedTeams[number]; rationale: string; nextAction: typeof recommendedActions[number];
      citations: Array<Omit<GroundedSource, 'content' | 'position'> & { excerpt: string }>; confidence: number; uncertainty: typeof uncertaintyLevels[number];
      humanReviewRequired: true; execution: { provider: 'ollama'; model: string; mode: 'local-model' }; metrics: { latencyMs: number; promptTokens: number | null; generatedTokens: number | null };
      disclaimer: 'Advisory only. Citations identify retrieved synthetic source chunks; they do not prove that a claim is entailed by a source.' }
  | { groundingState: 'INSUFFICIENT_EVIDENCE'; caseId: string; citations: []; humanReviewRequired: true;
      message: 'Available synthetic documents did not provide sufficient evidence.' };

/** Client-side guard for the fixed API response; citations remain associations, not proof of entailment. */
export function isGroundedAnalysisResult(value: unknown, expectedCaseId: string): value is GroundedAnalysisResult {
  if (!record(value) || value.caseId !== expectedCaseId || value.humanReviewRequired !== true || !Array.isArray(value.citations)) return false;
  if (value.groundingState === 'INSUFFICIENT_EVIDENCE') {
    return Object.keys(value).sort().join(',') === 'caseId,citations,groundingState,humanReviewRequired,message' &&
      value.citations.length === 0 && value.message === 'Available synthetic documents did not provide sufficient evidence.';
  }
  const keys = ['caseId', 'category', 'priority', 'recommendedTeam', 'rationale', 'nextAction', 'citations', 'confidence', 'uncertainty',
    'humanReviewRequired', 'execution', 'metrics', 'disclaimer'];
  if (value.groundingState !== 'SUPPORTED' || Object.keys(value).length !== keys.length + 1 ||
      !keys.every((key) => Object.hasOwn(value, key)) || !record(value.execution) || !record(value.metrics) ||
      value.execution.provider !== 'ollama' || value.execution.mode !== 'local-model' || typeof value.execution.model !== 'string' ||
      Object.keys(value.execution).length !== 3 || !Number.isSafeInteger(value.metrics.latencyMs) ||
      (value.metrics.latencyMs as number) < 0 || ![value.metrics.promptTokens, value.metrics.generatedTokens].every((n) => n === null || Number.isSafeInteger(n) && (n as number) >= 0) ||
      Object.keys(value.metrics).length !== 3 || value.disclaimer !== 'Advisory only. Citations identify retrieved synthetic source chunks; they do not prove that a claim is entailed by a source.' ||
      value.citations.length < 1 || value.citations.length > 5) return false;
  const sources: GroundedSource[] = [];
  for (const citation of value.citations) {
    if (!record(citation) || !citationUuid.test(String(citation.citationId)) || typeof citation.title !== 'string' || citation.title.length > 160 ||
        typeof citation.sourceIdentity !== 'string' || !/^SYNTHETIC-[A-Z0-9][A-Z0-9_-]{0,120}$/.test(citation.sourceIdentity) ||
        !Number.isSafeInteger(citation.version) || (citation.version as number) < 1 || typeof citation.excerpt !== 'string' || citation.excerpt.length > 280 ||
        Object.keys(citation).sort().join(',') !== 'citationId,excerpt,sourceIdentity,title,version') return false;
    sources.push({ citationId: citation.citationId as string, title: citation.title, sourceIdentity: citation.sourceIdentity,
      version: citation.version as number, position: 0, content: citation.excerpt });
  }
  try {
    parseGroundedProviderOutput({ groundingState: 'SUPPORTED', category: value.category, priority: value.priority,
      recommendedTeam: value.recommendedTeam, rationale: value.rationale, nextAction: value.nextAction,
      citations: value.citations.map((citation) => (citation as Record<string, unknown>).citationId), confidence: value.confidence,
      uncertainty: value.uncertainty, humanReviewRequired: value.humanReviewRequired }, sources);
    return true;
  } catch { return false; }
}

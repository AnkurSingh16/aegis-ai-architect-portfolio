import { categories, priorities, suggestedTeams } from '../contracts/triage.js';
import { recommendedActions, uncertaintyLevels } from './analysis.js';

const requiredGroundedFields = ['groundingState', 'category', 'priority', 'recommendedTeam', 'rationale', 'nextAction', 'citations',
  'confidence', 'uncertainty', 'humanReviewRequired'] as const;

const supportedGroundedProperties = {
  groundingState: { type: 'string', enum: ['SUPPORTED'] },
  category: { type: 'string', enum: categories },
  priority: { type: 'string', enum: priorities },
  recommendedTeam: { type: 'string', enum: suggestedTeams },
  rationale: { type: 'string', minLength: 1, maxLength: 700 },
  nextAction: { type: 'string', enum: recommendedActions },
  citations: { type: 'array', minItems: 1, maxItems: 5, items: { type: 'string' } },
  confidence: { type: 'number', minimum: 0, maximum: 1 },
  uncertainty: { type: 'string', enum: uncertaintyLevels },
  humanReviewRequired: { type: 'boolean', enum: [true] },
} as const;

const insufficientEvidenceProperties = {
  groundingState: { type: 'string', enum: ['INSUFFICIENT_EVIDENCE'] },
  category: { type: 'null' },
  priority: { type: 'null' },
  recommendedTeam: { type: 'null' },
  rationale: { type: 'null' },
  nextAction: { type: 'null' },
  citations: { type: 'array', maxItems: 0, items: { type: 'string' } },
  confidence: { type: 'null' },
  uncertainty: { type: 'string', enum: ['high'] },
  humanReviewRequired: { type: 'boolean', enum: [true] },
} as const;

/**
 * The alternatives mirror the parser's two accepted states. Ollama documents JSON Schema
 * structured output; llama.cpp's schema converter handles oneOf as a grammar alternative.
 * The server parser remains authoritative for dynamic citation membership and safe rationale.
 */
export const groundedAnalysisSchema = {
  oneOf: [
    { type: 'object', required: requiredGroundedFields, additionalProperties: false, properties: supportedGroundedProperties },
    { type: 'object', required: requiredGroundedFields, additionalProperties: false, properties: insufficientEvidenceProperties },
  ],
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
  /** Optional only when the authorized stored case has no narrative; absence must not be filled from fixture labels. */
  analyze(input: { caseStatus: string; caseType: string; caseFacts?: string; sources: readonly GroundedSource[] }, signal: AbortSignal,
    correlationId: string): Promise<{ output: GroundedProviderOutput; metrics: { latencyMs: number; promptTokens: number | null; generatedTokens: number | null } }>;
}

export const groundedValidationReasons = [
  'missing_required_field', 'unexpected_field', 'invalid_field_type', 'unsupported_enum', 'invalid_grounding_state',
  'invalid_state_combination', 'unsafe_rationale', 'missing_citation', 'invalid_citation_format', 'unknown_citation',
  'duplicate_citation', 'invalid_confidence', 'invalid_human_review',
] as const;
export type GroundedValidationReason = typeof groundedValidationReasons[number];

export class GroundedOutputError extends Error {
  constructor(readonly reason: 'invalid_output' | 'invalid_citations', readonly validationReason: GroundedValidationReason) {
    super('Grounded analysis output is invalid.');
  }
}

/** Stable, non-sensitive outcome classification for the authenticated route error contract. */
export class GroundedAnalysisFailureError extends Error {
  constructor(readonly state: 'VALIDATION_FAILED' | 'PROVIDER_UNAVAILABLE') {
    super('AI analysis is unavailable. Check the local development provider and retry.');
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function safeRationale(value: unknown): value is string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > 700) return false;
  // Only complete, unqualified prohibitions are exempt from the credential-term filter.
  const credentials = '(?:passwords?|recovery codes?|access tokens?|bearer tokens?|secrets?|api keys?)';
  const safeCredentialAdvice = new RegExp(`^(?:never|do not|don't|must not|should not)\\s+(?:request|ask|collect)(?:\\s+(?:users?\\s+to\\s+provide\\s+)?)?${credentials}(?:\\s+(?:and|or)\\s+${credentials})*[.!]?$`, 'i');
  const textToInspect = safeCredentialAdvice.test(value.trim()) ? '' : value;
  return !/<\/?[a-z][^>]*>|https?:\/\/|\b(?:bearer|api[_ -]?keys?|passwords?|secrets?|recovery codes?|access tokens?)\b|\bignore (?:all )?(?:prior|previous|system)|\bignore human review|\bexecute\b|\bescalate\b|\bsend (?:a )?(?:customer )?message|\bchange (?:the )?case status|\breveal (?:the )?(?:system )?prompt\b/i.test(textToInspect);
}

const citationUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Keeps generation output separate from authoritative request-scoped citation resolution. */
export function parseGroundedProviderOutput(value: unknown, sources: readonly GroundedSource[]): GroundedProviderOutput {
  const invalidOutput = (reason: GroundedValidationReason): never => { throw new GroundedOutputError('invalid_output', reason); };
  const invalidCitation = (reason: GroundedValidationReason): never => { throw new GroundedOutputError('invalid_citations', reason); };
  if (!record(value)) invalidOutput('invalid_field_type');
  const output = value as Record<string, unknown>;
  const keys = ['groundingState', 'category', 'priority', 'recommendedTeam', 'rationale', 'nextAction', 'citations', 'confidence', 'uncertainty', 'humanReviewRequired'];
  if (keys.some((key) => !Object.hasOwn(output, key))) invalidOutput('missing_required_field');
  if (Object.keys(output).some((key) => !keys.includes(key))) invalidOutput('unexpected_field');
  if (typeof output.humanReviewRequired !== 'boolean') invalidOutput('invalid_field_type');
  if (output.humanReviewRequired !== true) invalidOutput('invalid_human_review');
  if (typeof output.groundingState !== 'string') invalidOutput('invalid_field_type');
  if (output.groundingState !== 'SUPPORTED' && output.groundingState !== 'INSUFFICIENT_EVIDENCE') invalidOutput('invalid_grounding_state');
  if (output.groundingState === 'INSUFFICIENT_EVIDENCE' && output.category === null && output.priority === null &&
      output.recommendedTeam === null && output.rationale === null && output.nextAction === null && Array.isArray(output.citations) &&
      output.citations.length === 0 && output.confidence === null && output.uncertainty === 'high') {
    return output as GroundedProviderOutput;
  }
  if (output.groundingState === 'INSUFFICIENT_EVIDENCE') invalidOutput('invalid_state_combination');
  if (typeof output.category !== 'string' || typeof output.priority !== 'string' || typeof output.recommendedTeam !== 'string' ||
      typeof output.rationale !== 'string' || typeof output.nextAction !== 'string' || typeof output.uncertainty !== 'string') {
    invalidOutput('invalid_field_type');
  }
  if (!categories.includes(output.category as typeof categories[number]) || !priorities.includes(output.priority as typeof priorities[number]) ||
      !suggestedTeams.includes(output.recommendedTeam as typeof suggestedTeams[number]) || !recommendedActions.includes(output.nextAction as typeof recommendedActions[number]) ||
      !uncertaintyLevels.includes(output.uncertainty as typeof uncertaintyLevels[number])) invalidOutput('unsupported_enum');
  if (!safeRationale(output.rationale)) invalidOutput('unsafe_rationale');
  if (typeof output.confidence !== 'number' || !Number.isFinite(output.confidence) || output.confidence < 0 || output.confidence > 1) {
    invalidOutput('invalid_confidence');
  }
  if (!Array.isArray(output.citations)) invalidCitation('invalid_field_type');
  const citations = output.citations as unknown[];
  if (citations.length === 0) invalidCitation('missing_citation');
  if (citations.length > 5 || !citations.every((item) => typeof item === 'string' && citationUuid.test(item))) {
    invalidCitation('invalid_citation_format');
  }
  if (new Set(citations).size !== citations.length) invalidCitation('duplicate_citation');
  const allowed = new Set(sources.map((source) => source.citationId));
  if (citations.some((citation) => !allowed.has(citation as string))) invalidCitation('unknown_citation');
  return output as unknown as GroundedProviderOutput;
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

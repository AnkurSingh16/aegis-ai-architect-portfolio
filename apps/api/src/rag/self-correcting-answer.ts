import { guardAnswer } from '../context/output-guard.js';

/**
 * Bounded self-correcting answer loop. Retrieval, generation and query reformulation are injected, so the control flow
 * is deterministic and testable without a model. The loop never answers without evidence, and it abstains rather than
 * return text that fails the deterministic output guard or has no citation. This is a control loop only: it makes no
 * claim about answer quality, which needs a separate measured evaluation.
 */

export interface Evidence {
  readonly sourceId: string;
  readonly text: string;
  readonly score: number;
}

export interface GenerateInput {
  readonly question: string;
  readonly query: string;
  readonly evidence: readonly Evidence[];
  /** Problem names from the previous round only (e.g. 'unknown_citation'). Never the offending text. */
  readonly feedback: readonly string[];
}

export interface SelfCorrectionDeps {
  retrieve(query: string): Promise<readonly Evidence[]>;
  generate(input: GenerateInput): Promise<string>;
  /** Returns a new retrieval query, or null when no useful reformulation exists. */
  reformulate(input: { question: string; query: string; feedback: readonly string[] }): Promise<string | null>;
}

export interface SelfCorrectionPolicy {
  /** 1 to 3 attempts. Each attempt retrieves, generates and checks once. */
  readonly maxRounds: number;
  /** Evidence below this score is ignored. */
  readonly minScore: number;
  /** Strings that must not appear in an answer. */
  readonly forbiddenSubstrings: readonly string[];
  /**
   * When true, a round with no usable evidence asks reformulate for one new query and tries again, if rounds remain.
   * Default false: the loop then behaves exactly as before. See docs/DEV-C4-REFORMULATION.md.
   */
  readonly retryOnInsufficientEvidence?: boolean;
  /**
   * When true, an answer whose text is only citations or the Sources label (no words of its own) is a failed round.
   * Default false, so the recorded evaluation runs stay reproducible. The answer route turns it on.
   * See docs/DEV-C4-PROMPT-V5.md (the Sources-only answers found in the v5 run).
   */
  readonly requireAnswerText?: boolean;
}

export type Problem = 'empty_answer' | 'forbidden_substring' | 'unknown_citation' | 'no_citation' | 'no_answer_text';

const CITATION_TOKEN = /\[[a-z0-9][a-z0-9._-]*\]/gi;
const SOURCES_LABEL = /sources?\s*:/gi;

/** True when the answer has a run of three letters or digits outside its citations and its Sources label. */
export function hasAnswerText(answer: string): boolean {
  const body = answer.replace(CITATION_TOKEN, ' ').replace(SOURCES_LABEL, ' ');
  return /[a-z0-9]{3,}/i.test(body);
}

export type SelfCorrectionResult =
  | { readonly status: 'answered'; readonly answer: string; readonly citations: readonly string[]; readonly rounds: number; readonly problemHistory: readonly (readonly Problem[])[] }
  | { readonly status: 'abstained'; readonly reason: 'insufficient_evidence' | 'guard_failed' | 'reformulation_unavailable'; readonly rounds: number; readonly problemHistory: readonly (readonly Problem[])[] };

const MAX_QUERY_LENGTH = 500;

function validatePolicy(policy: SelfCorrectionPolicy): void {
  if (!Number.isInteger(policy.maxRounds) || policy.maxRounds < 1 || policy.maxRounds > 3) {
    throw new RangeError('maxRounds must be an integer from 1 to 3');
  }
  if (!Number.isFinite(policy.minScore)) throw new RangeError('minScore must be a finite number');
}

export async function answerWithSelfCorrection(
  question: string,
  deps: SelfCorrectionDeps,
  policy: SelfCorrectionPolicy,
): Promise<SelfCorrectionResult> {
  validatePolicy(policy);
  if (question.trim().length === 0) throw new RangeError('question must not be empty');

  const problemHistory: Problem[][] = [];
  let query = question;
  let feedback: string[] = [];

  for (let round = 1; round <= policy.maxRounds; round += 1) {
    const usable = (await deps.retrieve(query)).filter((item) => item.score >= policy.minScore);
    if (usable.length === 0) {
      // Off by default. When on, a round with no usable evidence asks for one reworded query before it gives up.
      if (!policy.retryOnInsufficientEvidence || round === policy.maxRounds) {
        return { status: 'abstained', reason: 'insufficient_evidence', rounds: round, problemHistory };
      }
      const next = await deps.reformulate({ question, query, feedback: ['insufficient_evidence'] });
      if (next === null || next.trim().length === 0 || next.length > MAX_QUERY_LENGTH) {
        return { status: 'abstained', reason: 'insufficient_evidence', rounds: round, problemHistory };
      }
      query = next.trim();
      continue;
    }

    const answer = await deps.generate({ question, query, evidence: usable, feedback });
    const guard = guardAnswer(answer, {
      forbiddenSubstrings: policy.forbiddenSubstrings,
      allowedSourceIds: new Set(usable.map((item) => item.sourceId)),
    });
    const problems: Problem[] = [...guard.violations];
    if (guard.ok && guard.citedSourceIds.length === 0) problems.push('no_citation');
    if (policy.requireAnswerText && !hasAnswerText(answer)) problems.push('no_answer_text');

    if (problems.length === 0) {
      return { status: 'answered', answer: answer.trim(), citations: guard.citedSourceIds, rounds: round, problemHistory };
    }

    problemHistory.push(problems);
    feedback = problems;
    if (round === policy.maxRounds) break;

    const next = await deps.reformulate({ question, query, feedback });
    if (next === null || next.trim().length === 0 || next.length > MAX_QUERY_LENGTH) {
      return { status: 'abstained', reason: 'reformulation_unavailable', rounds: round, problemHistory };
    }
    query = next.trim();
  }

  return { status: 'abstained', reason: 'guard_failed', rounds: policy.maxRounds, problemHistory };
}

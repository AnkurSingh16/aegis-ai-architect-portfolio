/**
 * Deterministic post-generation checks. The model's output is treated as untrusted:
 * a prompt-level delimiter does not stop instruction-following, so these rules decide.
 */

export interface GuardPolicy {
  /** Strings that must never appear in an answer (e.g. sentinels planted in untrusted evidence). */
  readonly forbiddenSubstrings: readonly string[];
  /** Source ids the answer may cite, from the assembled context provenance. */
  readonly allowedSourceIds: ReadonlySet<string>;
}

export interface GuardResult {
  readonly ok: boolean;
  readonly violations: readonly ('forbidden_substring' | 'unknown_citation' | 'empty_answer')[];
  readonly citedSourceIds: readonly string[];
}

const CITATION = /\[([a-z0-9][a-z0-9._-]*)\]/gi;

export function guardAnswer(answer: string, policy: GuardPolicy): GuardResult {
  const violations: GuardResult['violations'][number][] = [];
  const trimmed = answer.trim();
  if (trimmed.length === 0) violations.push('empty_answer');
  const lower = trimmed.toLowerCase();
  if (policy.forbiddenSubstrings.some((needle) => needle.length > 0 && lower.includes(needle.toLowerCase()))) {
    violations.push('forbidden_substring');
  }
  const cited = [...trimmed.matchAll(CITATION)].map((match) => match[1]!);
  if (cited.some((id) => !policy.allowedSourceIds.has(id))) violations.push('unknown_citation');
  return { ok: violations.length === 0, violations, citedSourceIds: cited };
}

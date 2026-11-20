/**
 * Question-echo check, version 1. Development only: it is not called by the answer route. It is evaluated under its own
 * protocol before any use (docs/DEV-C4-ANSWER-QUALITY-V8-PROTOCOL.md, owner review). It flags an answer whose body uses only
 * words from the question, so the answer repeats the question. It does not judge truth, completeness or source copying.
 *
 * Rule: strip citation tokens and the Sources label. If the remaining body has at least three words and every one of them
 * appears in the question, it is an echo. Short answers such as "No" or "Yes" are never flagged.
 */
export const QUESTION_ECHO_CHECK = 'echo-v1' as const;

const CITATION_TOKEN = /\[[a-z0-9][a-z0-9._-]*\]/gi;
const SOURCES_LABEL = /sources?\s*:/gi;
const MIN_BODY_WORDS = 3;

function words(text: string): string[] {
  return text.toLowerCase().split(/[^a-z0-9]+/).filter((word) => word.length > 0);
}

export function isQuestionEcho(question: string, answer: string): boolean {
  const body = words(answer.replace(CITATION_TOKEN, ' ').replace(SOURCES_LABEL, ' '));
  if (body.length < MIN_BODY_WORDS) return false;
  const questionWords = new Set(words(question));
  return body.every((word) => questionWords.has(word));
}

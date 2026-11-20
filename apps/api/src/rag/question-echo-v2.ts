/**
 * Question-echo check, version 2. Development only: the answer route does not call it. Its change and its measurement are
 * fixed in docs/DEV-C4-QUESTION-ECHO-V2-PROTOCOL.md before any evaluation. Version 1 (question-echo.ts) is kept unchanged.
 *
 * It answers one narrow question: does the answer only repeat the question? It does not judge whether the answer is true,
 * complete or supported by its source. An answer that is not an echo is not thereby correct.
 *
 * Rule, applied to the answer after citations and the Sources label are removed:
 * - Split the text into sentences. An empty answer is "no_text" and is not an echo.
 * - A sentence ending in "?" is a question sentence.
 * - A statement sentence is a restatement when it has at least three content words and every content word also appears in
 *   the question. Content words are the lowercased alphanumeric words that are not function words, after light suffix
 *   stripping. Negation words are always content words, so "does not" can never match a question that has no negation.
 * - Any other sentence, including a short answer such as "Yes" or "No", makes the answer responsive, so it is not an echo.
 * - The answer is an echo only when it has no responsive sentence and at least one question or restatement sentence.
 *
 * Known limits (recorded in the tests): paraphrased statements that add new words are not flagged, and a responsive-looking
 * statement built only from question words is flagged.
 */
export const QUESTION_ECHO_CHECK_V2 = 'echo-v2' as const;

export type EchoReason = 'no_text' | 'answer_present' | 'question_only' | 'restated';

export interface EchoVerdict {
  readonly echo: boolean;
  readonly reason: EchoReason;
}

const CITATION_TOKEN = /\[[a-z0-9][a-z0-9._-]*\]/gi;
const SOURCES_LABEL = /sources?\s*:/gi;
const MIN_RESTATED_CONTENT_WORDS = 3;

const NEGATIONS = new Set(['not', 'no', 'never', 'cannot', 'without', 'nothing', 'none', 'neither', 'nor']);
const FUNCTION_WORDS = new Set(['a', 'an', 'the', 'and', 'or', 'of', 'to', 'in', 'on', 'at', 'for', 'from', 'by', 'with', 'as',
  'is', 'are', 'was', 'were', 'be', 'been', 'am', 'do', 'does', 'did', 'can', 'could', 'should', 'would', 'will', 'shall', 'may',
  'might', 'must', 'i', 'me', 'my', 'we', 'our', 'you', 'your', 'it', 'its', 'this', 'that', 'these', 'those', 'there', 'here',
  'what', 'which', 'who', 'whom', 'whose', 'when', 'where', 'why', 'how', 'if', 'then', 'so', 'than', 'into', 'about', 'after',
  'before', 'until', 'only', 'also', 'just', 'any', 'some', 'each', 'every', 'they', 'them', 'their', 'he', 'she', 'his', 'her']);

/** Light, predictable suffix stripping. Not a stemmer: it only has to match the same word in question and answer. */
function stem(word: string): string {
  if (word.length > 4 && word.endsWith('ing')) return word.slice(0, -3);
  if (word.length > 4 && word.endsWith('ed')) return word.slice(0, -2);
  if (word.length > 3 && word.endsWith('s') && !word.endsWith('ss')) return word.slice(0, -1);
  return word;
}

function words(text: string): string[] {
  return text.toLowerCase().split(/[^a-z0-9]+/).filter((word) => word.length > 0);
}

function contentWords(text: string): string[] {
  return words(text).filter((word) => NEGATIONS.has(word) || !FUNCTION_WORDS.has(word)).map(stem);
}

function sentencesOf(answer: string): string[] {
  return answer.replace(CITATION_TOKEN, ' ').replace(SOURCES_LABEL, ' ')
    .split(/(?<=[.!?])\s+|\n+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 0);
}

export function questionEchoV2(question: string, answer: string): EchoVerdict {
  const sentences = sentencesOf(answer);
  if (sentences.length === 0) return { echo: false, reason: 'no_text' };

  const questionContent = new Set(contentWords(question));
  let questionSentences = 0;
  let restatements = 0;
  for (const sentence of sentences) {
    if (sentence.endsWith('?')) {
      questionSentences += 1;
      continue;
    }
    const content = contentWords(sentence);
    const restates = content.length >= MIN_RESTATED_CONTENT_WORDS && content.every((word) => questionContent.has(word));
    if (!restates) return { echo: false, reason: 'answer_present' };
    restatements += 1;
  }
  if (restatements > 0) return { echo: true, reason: 'restated' };
  return { echo: questionSentences > 0, reason: 'question_only' };
}

export function isQuestionEchoV2(question: string, answer: string): boolean {
  return questionEchoV2(question, answer).echo;
}

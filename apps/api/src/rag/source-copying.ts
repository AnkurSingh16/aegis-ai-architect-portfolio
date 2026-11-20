/**
 * Source-copying measure. Report only: it is never a rejection rule. Copying the source is not wrong in itself. It is reported
 * so that reviewers can see near-verbatim answers. Pure, deterministic.
 */

/** Reporting threshold, chosen here and not measured. A longer verbatim run is reported as near-verbatim copying. */
export const COPY_REPORT_SPAN_WORDS = 12;

const CITATION_TOKEN = /\[[a-z0-9][a-z0-9._-]*\]/gi;
const SOURCES_LABEL = /sources?\s*:/gi;

function words(text: string): string[] {
  return text.toLowerCase().split(/[^a-z0-9]+/).filter((word) => word.length > 0);
}

/** Length, in words, of the longest run that appears in order and unbroken in both the answer body and the source. */
export function longestVerbatimRun(answer: string, source: string): number {
  const body = words(answer.replace(CITATION_TOKEN, ' ').replace(SOURCES_LABEL, ' '));
  const reference = words(source);
  if (body.length === 0 || reference.length === 0) return 0;
  let best = 0;
  let previous = new Array<number>(reference.length + 1).fill(0);
  for (let i = 1; i <= body.length; i += 1) {
    const current = new Array<number>(reference.length + 1).fill(0);
    for (let j = 1; j <= reference.length; j += 1) {
      if (body[i - 1] === reference[j - 1]) {
        current[j] = previous[j - 1]! + 1;
        if (current[j]! > best) best = current[j]!;
      }
    }
    previous = current;
  }
  return best;
}

export function isNearVerbatim(answer: string, source: string): boolean {
  return longestVerbatimRun(answer, source) >= COPY_REPORT_SPAN_WORDS;
}

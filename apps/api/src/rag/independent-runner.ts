/**
 * Runner adapter for a locked independent set (docs/C4-INDEPENDENT-EVAL-KIT/06-execution-and-locking.md).
 *
 * It does four things, all with injected providers and no network access:
 * 1. loads a set file only if its SHA-256 matches the lock, and only if it passes the validator;
 * 2. maps items to the labelled form the loop uses;
 * 3. runs the real answer loop with injected retrieve, generate and reformulate functions;
 * 4. scores the records and builds a report in a stable, reproducible form.
 *
 * Automatic measures are computed here. Human measures are reported as "not_adjudicated" unless a complete human review is
 * supplied, so an automatic result is never presented as human-validated. Nothing here writes questions or labels.
 */
import { createHash } from 'node:crypto';
import { answerWithSelfCorrection, type Evidence, type GenerateInput, type SelfCorrectionPolicy, type SelfCorrectionResult } from './self-correcting-answer.js';
import { type IndependentItem, type Role, validateIndependentSet } from './independent-set.js';
import { questionEchoV2 } from './question-echo-v2.js';
import { COPY_REPORT_SPAN_WORDS, longestVerbatimRun } from './source-copying.js';
import { wilsonInterval, type Interval } from '../retrieval/eval/wilson-interval.js';

export const INDEPENDENT_RUNNER_VERSION = 'independent-runner-v1' as const;

export interface LockedSet {
  readonly corpusVersion: string;
  readonly role: Role;
  readonly items: readonly IndependentItem[];
  readonly setSha256: string;
}

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** Loads and checks a set file. Throws with a clear reason on any failure. Pure apart from hashing. */
export function loadLockedSet(fileText: string, expectedSha256: string, role: Role, existingQuestions: readonly string[] = []): LockedSet {
  if (!/^[0-9a-f]{64}$/.test(expectedSha256)) throw new Error('expected SHA-256 must be 64 lowercase hex characters');
  const actual = sha256Hex(fileText);
  if (actual !== expectedSha256) throw new Error(`set hash mismatch: locked ${expectedSha256}, file ${actual}`);

  let parsed: unknown;
  try {
    parsed = JSON.parse(fileText);
  } catch {
    throw new Error('set is not valid JSON');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('set must be a JSON object');
  const file = parsed as Record<string, unknown>;
  if (typeof file.corpusVersion !== 'string' || file.corpusVersion.trim().length === 0) throw new Error('corpusVersion is required');
  if (file.role !== role) throw new Error(`set role is ${String(file.role)}, expected ${role}`);
  if (!Array.isArray(file.items)) throw new Error('items must be an array');
  for (const item of file.items as unknown[]) {
    if (typeof item !== 'object' || item === null || typeof (item as { id?: unknown }).id !== 'string') {
      throw new Error('every item must be an object with a string id');
    }
  }
  const items = file.items as IndependentItem[];
  const problems = validateIndependentSet(items, role, existingQuestions);
  if (problems.length > 0) throw new Error(`set failed validation: ${problems.join('; ')}`);
  return { corpusVersion: file.corpusVersion, role, items, setSha256: expectedSha256 };
}

export interface LabelledForLoop {
  readonly id: string;
  readonly question: string;
  readonly expected: { readonly kind: 'answer'; readonly sourceId: string } | { readonly kind: 'abstain' };
}

export function toLabelledCases(items: readonly IndependentItem[]): LabelledForLoop[] {
  return items.map((item) => (item.kind === 'answerable'
    ? { id: item.id, question: item.question, expected: { kind: 'answer', sourceId: item.supportingDocumentId! } }
    : { id: item.id, question: item.question, expected: { kind: 'abstain' } }));
}

export interface RunnerDeps {
  retrieve(query: string): Promise<readonly Evidence[]>;
  generate(input: GenerateInput): Promise<string>;
  reformulate(input: { question: string; query: string; feedback: readonly string[] }): Promise<string | null>;
}

export interface ItemRecord {
  readonly id: string;
  readonly kind: 'answerable' | 'unanswerable';
  readonly category: string;
  readonly status: 'answered' | 'abstained' | 'generation_failed';
  readonly citations: readonly string[];
  readonly answer: string;
  readonly reason: string;
  readonly rounds: number;
  readonly topScore: number | null;
  readonly topSourceId: string | null;
  readonly failure: string;
}

/** Runs the real loop over every item. A failure from a provider is recorded as a generation failure, not as an answer or abstention. */
export async function runLockedSet(set: LockedSet, deps: RunnerDeps, policy: SelfCorrectionPolicy): Promise<ItemRecord[]> {
  const records: ItemRecord[] = [];
  for (const item of set.items) {
    let lastEvidence: readonly Evidence[] = [];
    const wrapped = {
      retrieve: async (query: string) => {
        lastEvidence = await deps.retrieve(query);
        return lastEvidence;
      },
      generate: deps.generate,
      reformulate: deps.reformulate,
    };
    try {
      const result: SelfCorrectionResult = await answerWithSelfCorrection(item.question, wrapped, policy);
      const base = { id: item.id, kind: item.kind, category: item.category, failure: '' };
      if (result.status === 'answered') {
        records.push({ ...base, status: 'answered', citations: result.citations, answer: result.answer, reason: '', rounds: result.rounds,
          topScore: lastEvidence[0]?.score ?? null, topSourceId: lastEvidence[0]?.sourceId ?? null });
      } else {
        records.push({ ...base, status: 'abstained', citations: [], answer: '', reason: result.reason, rounds: result.rounds,
          topScore: lastEvidence[0]?.score ?? null, topSourceId: lastEvidence[0]?.sourceId ?? null });
      }
    } catch (error) {
      const failure = error instanceof Error ? error.name : 'unknown';
      records.push({ id: item.id, kind: item.kind, category: item.category, status: 'generation_failed', citations: [], answer: '',
        reason: '', rounds: 0, failure, topScore: lastEvidence[0]?.score ?? null, topSourceId: lastEvidence[0]?.sourceId ?? null });
    }
  }
  return records;
}

export interface Measure {
  readonly count: number;
  readonly denominator: number;
  readonly rate: number | null;
  readonly interval: Interval | null;
  readonly basis: 'automatic' | 'human';
  readonly status: 'computed' | 'not_adjudicated' | 'not_computed' | 'no_denominator';
}

function measure(count: number, denominator: number, basis: Measure['basis'], status: Measure['status'] = 'computed'): Measure {
  if (denominator === 0) return { count, denominator, rate: null, interval: null, basis, status: 'no_denominator' };
  return { count, denominator, rate: count / denominator, interval: wilsonInterval(count, denominator), basis, status };
}

/** Human review of answered items. Only a complete review (every answered item has a row) produces a computed measure. */
export interface HumanRow { readonly responsive: boolean; readonly complete: boolean; readonly supported: boolean; readonly echo: boolean }

export interface ScoreOptions {
  readonly floor: number;
  /** Full text of each document, keyed by source id, for the copying measure. Without it the copying measure is not computed. */
  readonly documentTexts?: Readonly<Record<string, string>>;
  readonly humanReview?: Readonly<Record<string, HumanRow>>;
}

export function scoreRecords(items: readonly IndependentItem[], records: readonly ItemRecord[], options: ScoreOptions) {
  const byId = new Map(items.map((item) => [item.id, item]));
  const answerable = records.filter((r) => r.kind === 'answerable' && r.status !== 'generation_failed');
  const unanswerable = records.filter((r) => r.kind === 'unanswerable' && r.status !== 'generation_failed');
  const answered = records.filter((r) => r.status === 'answered');
  const answeredAnswerable = answered.filter((r) => r.kind === 'answerable');
  const answeredUnanswerable = answered.filter((r) => r.kind === 'unanswerable');
  const abstained = records.filter((r) => r.status === 'abstained');
  const support = (id: string) => byId.get(id)?.supportingDocumentId ?? '';

  const correct = answeredAnswerable.filter((r) => r.citations.includes(support(r.id))).length;
  const wrongSource = answeredAnswerable.filter((r) => !r.citations.includes(support(r.id))).length;
  const abstainedCorrectly = abstained.filter((r) => r.kind === 'unanswerable').length;
  const retrievalFailures = answerable.filter((r) => r.topSourceId !== support(r.id) || r.topScore === null || r.topScore < options.floor).length;
  const echoes = answered.filter((r) => questionEchoV2(byId.get(r.id)?.question ?? '', r.answer).echo).length;

  const automatic: Record<string, Measure> = {
    answerRecall: measure(correct, answerable.length, 'automatic'),
    falseAnswers: measure(answeredUnanswerable.length, unanswerable.length, 'automatic'),
    wrongSourceAnswers: measure(wrongSource, answeredAnswerable.length, 'automatic'),
    abstentionPrecision: measure(abstainedCorrectly, abstained.length, 'automatic'),
    citationProblems: measure(answered.filter((r) => r.citations.length === 0).length, answered.length, 'automatic'),
    retrievalFailures: measure(retrievalFailures, answerable.length, 'automatic'),
    generationFailures: measure(records.filter((r) => r.status === 'generation_failed').length, records.length, 'automatic'),
    echoAutomatic: measure(echoes, answered.length, 'automatic'),
  };
  if (options.documentTexts) {
    const texts = options.documentTexts;
    const copied = answered.filter((r) => {
      const source = r.citations[0] ? texts[r.citations[0]] : undefined;
      return source !== undefined && longestVerbatimRun(r.answer, source) >= COPY_REPORT_SPAN_WORDS;
    }).length;
    automatic.nearVerbatimCopy = measure(copied, answered.length, 'automatic');
  } else {
    automatic.nearVerbatimCopy = measure(0, answered.length, 'automatic', 'not_computed');
  }

  const review = options.humanReview;
  const reviewed = review !== undefined && answered.every((r) => review[r.id] !== undefined);
  const human: Record<string, Measure> = {};
  const humanMeasure = (name: keyof HumanRow) => {
    if (!reviewed || review === undefined) {
      human[name] = measure(0, answered.length, 'human', 'not_adjudicated');
      return;
    }
    const count = answered.filter((r) => review[r.id]![name]).length;
    human[name] = measure(count, answered.length, 'human');
  };
  humanMeasure('responsive');
  humanMeasure('complete');
  humanMeasure('supported');
  humanMeasure('echo');

  return { automatic, human, counts: { items: records.length, answered: answered.length, abstained: abstained.length,
    generationFailures: records.filter((r) => r.status === 'generation_failed').length } };
}

/** Deterministic JSON: object keys sorted at every level, so two runs over the same inputs produce the same bytes. */
export function stableJson(value: unknown): string {
  const sort = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(sort);
    if (input !== null && typeof input === 'object') {
      return Object.fromEntries(Object.keys(input as object).sort().map((key) => [key, sort((input as Record<string, unknown>)[key])]));
    }
    return input;
  };
  return `${JSON.stringify(sort(value), null, 2)}\n`;
}

export interface ReportProvenance {
  readonly corpusVersion: string;
  readonly role: Role;
  readonly setSha256: string;
  readonly policy: SelfCorrectionPolicy;
  readonly floor: number;
  readonly promptVersion: string;
  readonly model: { readonly name: string; readonly digest: string };
  readonly runnerVersion: typeof INDEPENDENT_RUNNER_VERSION;
}

export function buildReport(provenance: ReportProvenance, items: readonly IndependentItem[], records: readonly ItemRecord[], options: ScoreOptions): string {
  const scores = scoreRecords(items, records, options);
  return stableJson({ provenance, counts: scores.counts, automatic: scores.automatic, human: scores.human, records });
}

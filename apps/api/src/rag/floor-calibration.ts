import type { LabelledCase } from './abstention-cases.js';
import { scoreAbstentionCases, type AbstentionReport, type CaseOutcome } from './abstention-evaluation.js';

/** Evidence for one case from a single retrieval, best first, as the loop receives it. */
export interface RankedEvidence { readonly sourceId: string; readonly score: number }

/**
 * The loop's first round with a generator that cites the top evidence item: it answers when at least one item clears the
 * floor, and cites the best of them. A sweep built from this is exact only for that generator and for a first-round
 * answer. The loop itself must be run at the chosen floor to confirm (the integration test does this).
 */
export function outcomeAtFloor(evidence: readonly RankedEvidence[], floor: number): CaseOutcome {
  const usable = evidence.filter((item) => item.score >= floor);
  const top = usable[0];
  return top ? { status: 'answered', citations: [top.sourceId] } : { status: 'abstained' };
}

/** Candidate floors 0.50 to 0.80 in steps of 0.01, built from integers so the values are exact. */
export const floorCandidates: readonly number[] = Array.from({ length: 31 }, (_, index) => (50 + index) / 100);

export interface FloorRow { readonly floor: number; readonly report: AbstentionReport }

export function sweepFloors(cases: readonly LabelledCase[], evidenceByCase: readonly (readonly RankedEvidence[])[],
  candidates: readonly number[] = floorCandidates): FloorRow[] {
  return candidates.map((floor) => ({
    floor,
    report: scoreAbstentionCases(cases, evidenceByCase.map((evidence) => outcomeAtFloor(evidence, floor))),
  }));
}

/** Fixed rule: maximise answer recall minus false-answer rate (null counts as 0); ties go to the higher floor. */
export function chooseFloor(cases: readonly LabelledCase[], evidenceByCase: readonly (readonly RankedEvidence[])[],
  candidates: readonly number[] = floorCandidates): { floor: number; rows: FloorRow[] } {
  const rows = sweepFloors(cases, evidenceByCase, candidates);
  let best: FloorRow | undefined;
  let bestValue = -Infinity;
  for (const row of rows) {
    const value = (row.report.answerRecall ?? 0) - (row.report.falseAnswerRate ?? 0);
    // Ratios of small counts are not exact in floating point, so two equal values can differ by one unit in the last place.
    // Compare with a tolerance, so that exact ties still go to the higher floor.
    const tolerance = 1e-9;
    if (value > bestValue + tolerance || (Math.abs(value - bestValue) <= tolerance && best !== undefined && row.floor > best.floor)) {
      best = row;
      bestValue = value;
    }
  }
  if (!best) throw new RangeError('no candidate floors');
  return { floor: best.floor, rows };
}

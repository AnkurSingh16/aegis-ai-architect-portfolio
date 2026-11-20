import { describe, expect, it } from 'vitest';
import type { LabelledCase } from './abstention-cases.js';
import { chooseFloor, floorCandidates, outcomeAtFloor, sweepFloors } from './floor-calibration.js';

const cases: LabelledCase[] = [
  { id: 'a', question: 'q', expected: { kind: 'answer', sourceId: 'DOC-A' } },
  { id: 'u', question: 'q', expected: { kind: 'abstain' } },
];

describe('outcomeAtFloor', () => {
  it('answers with the best item that clears the floor, and abstains when none does', () => {
    const evidence = [{ sourceId: 'DOC-A', score: 0.8 }, { sourceId: 'DOC-B', score: 0.6 }];
    expect(outcomeAtFloor(evidence, 0.7)).toEqual({ status: 'answered', citations: ['DOC-A'] });
    expect(outcomeAtFloor(evidence, 0.6)).toEqual({ status: 'answered', citations: ['DOC-A'] });
    expect(outcomeAtFloor(evidence, 0.9)).toEqual({ status: 'abstained' });
    expect(outcomeAtFloor([], 0.5)).toEqual({ status: 'abstained' });
  });
});

describe('floorCandidates', () => {
  it('covers 0.50 to 0.80 in exact steps of 0.01', () => {
    expect(floorCandidates[0]).toBe(0.5);
    expect(floorCandidates[floorCandidates.length - 1]).toBe(0.8);
    expect(floorCandidates).toHaveLength(31);
    expect(floorCandidates[7]).toBe(0.57);
  });
});

describe('chooseFloor', () => {
  it('picks the floor that maximises answer recall minus false-answer rate', () => {
    // Answerable best score 0.7; unanswerable best score 0.6. Floors up to 0.6 answer both (value 0). From 0.65 on,
    // only the answerable case answers (value 1). 0.65 and 0.7 tie at 1, so the higher floor wins.
    const evidence = [[{ sourceId: 'DOC-A', score: 0.7 }], [{ sourceId: 'DOC-X', score: 0.6 }]];
    const { floor } = chooseFloor(cases, evidence, [0.5, 0.6, 0.65, 0.7]);
    expect(floor).toBe(0.7);
  });

  it('breaks ties toward the higher floor', () => {
    const evidence = [[{ sourceId: 'DOC-A', score: 0.9 }], [{ sourceId: 'DOC-X', score: 0.1 }]];
    // Both 0.5 and 0.8 give recall 1 and no false answers.
    expect(chooseFloor(cases, evidence, [0.5, 0.8]).floor).toBe(0.8);
  });

  it('reports one row per candidate', () => {
    const rows = sweepFloors(cases, [[{ sourceId: 'DOC-A', score: 0.7 }], []], [0.5, 0.9]);
    expect(rows.map((row) => row.floor)).toEqual([0.5, 0.9]);
    expect(rows[1]!.report.falseAbstentions).toBe(1);
  });
});

describe('chooseFloor exact ties', () => {
  it('treats values that are equal as fractions as a tie, even when floating point disagrees in the last digit', () => {
    // Floor 0.5: recall 3/3, false answers 1/3, value 1 - 1/3. Floor 0.7: recall 2/3, false answers 0, value 2/3.
    // The two are equal as fractions but differ by one unit in the last place in floating point. The tie goes to 0.7.
    const threeAnswerable: LabelledCase[] = [
      { id: 'a1', question: 'q', expected: { kind: 'answer', sourceId: 'DOC-A1' } },
      { id: 'a2', question: 'q', expected: { kind: 'answer', sourceId: 'DOC-A2' } },
      { id: 'a3', question: 'q', expected: { kind: 'answer', sourceId: 'DOC-A3' } },
      { id: 'u1', question: 'q', expected: { kind: 'abstain' } },
      { id: 'u2', question: 'q', expected: { kind: 'abstain' } },
      { id: 'u3', question: 'q', expected: { kind: 'abstain' } },
    ];
    const evidence = [
      [{ sourceId: 'DOC-A1', score: 0.9 }],
      [{ sourceId: 'DOC-A2', score: 0.9 }],
      [{ sourceId: 'DOC-A3', score: 0.6 }],
      [{ sourceId: 'DOC-X', score: 0.6 }],
      [],
      [],
    ];
    expect(chooseFloor(threeAnswerable, evidence, [0.5, 0.7]).floor).toBe(0.7);
  });
});

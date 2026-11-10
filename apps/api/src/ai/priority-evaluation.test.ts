import { describe, expect, it } from 'vitest';
import { priorityScenarios, scorePriority } from './priority-evaluation.js';

describe('predeclared synthetic priority regression labels', () => {
  it('covers distinct severity signals and scores explicit denominators without inference', () => {
    expect(priorityScenarios).toHaveLength(9);
    expect(new Set(priorityScenarios.map((scenario) => scenario.id)).size).toBe(9);
    expect(priorityScenarios.every((scenario) => scenario.rationale.length > 20)).toBe(true);
    const exact = scorePriority(priorityScenarios.map(({ id, expected }) => ({ scenarioId: id, priority: expected })));
    expect(exact).toMatchObject({ labelStatus: 'engineering-reviewed', exactMatch: { numerator: 9, denominator: 9, rate: 1 },
      validPriority: { numerator: 9, denominator: 9, rate: 1 } });
    const wrong = scorePriority(priorityScenarios.map(({ id }) => ({ scenarioId: id, priority: 'invalid' })));
    expect(wrong).toMatchObject({ exactMatch: { numerator: 0, denominator: 9 }, validPriority: { numerator: 0, denominator: 9 } });
  });
});

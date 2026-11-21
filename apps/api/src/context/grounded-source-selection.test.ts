import { describe, expect, it } from 'vitest';
import type { GroundedSource } from '../ai/grounded-analysis.js';
import { CONTEXT_ASSEMBLER_ENV, contextAssemblyFromEnv, PROVISIONAL_CONTEXT_BUDGET, selectGroundedSources } from './grounded-source-selection.js';

const source = (n: number, content: string): GroundedSource => ({ citationId: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
  title: `Synthetic guide ${n}`, sourceIdentity: `SYNTHETIC-NORTH-DOC-${n}`, version: 1, position: n, content });

const generous = { budgetTokens: 10_000, reservedOutputTokens: 100 };

describe('context assembly is off by default', () => {
  it('stays disabled unless AEGIS_CONTEXT_ASSEMBLER is exactly "enabled"', () => {
    expect(contextAssemblyFromEnv({}).enabled).toBe(false);
    expect(contextAssemblyFromEnv({ [CONTEXT_ASSEMBLER_ENV]: '1' }).enabled).toBe(false);
    expect(contextAssemblyFromEnv({ [CONTEXT_ASSEMBLER_ENV]: 'enabled' }).enabled).toBe(true);
    expect(contextAssemblyFromEnv({}).budgetTokens).toBe(PROVISIONAL_CONTEXT_BUDGET.budgetTokens);
  });
});

describe('selection through the assembler', () => {
  const sources = [source(1, 'First synthetic procedure about sign-in interruptions and the status page.'),
    source(2, 'Second synthetic procedure about recovery requests and identity verification steps.'),
    source(3, 'Third synthetic procedure about network diagnostics and loopback health checks.')];

  it('keeps every source, in retrieval order, when the budget is generous', () => {
    const selection = selectGroundedSources(sources, 'sign-in interruption', generous);
    expect(selection.sources.map((s) => s.citationId)).toEqual(sources.map((s) => s.citationId));
    expect(selection.dropped).toEqual([]);
  });

  it('keeps the highest-ranked prefix when the budget is tight, and reports what it dropped and why', () => {
    const oneFits = selectGroundedSources(sources, 'sign-in interruption', { budgetTokens: 80, reservedOutputTokens: 0 });
    expect(oneFits.sources.length).toBeGreaterThan(0);
    expect(oneFits.sources.length).toBeLessThan(sources.length);
    expect(oneFits.sources.map((s) => s.citationId)).toEqual(sources.slice(0, oneFits.sources.length).map((s) => s.citationId));
    expect(oneFits.dropped.every((d) => d.reason === 'over_budget')).toBe(true);
  });

  it('drops a source whose content repeats an earlier source (duplicate)', () => {
    const repeated = [sources[0]!, { ...sources[1]!, content: sources[0]!.content }];
    const selection = selectGroundedSources(repeated, 'sign-in', generous);
    expect(selection.sources).toHaveLength(1);
    expect(selection.dropped).toEqual([{ citationId: repeated[1]!.citationId, reason: 'duplicate' }]);
  });

  it('selects nothing, rather than sending evidence, when even the question and instruction do not fit', () => {
    const selection = selectGroundedSources(sources, 'sign-in interruption', { budgetTokens: 5, reservedOutputTokens: 0 });
    expect(selection.sources).toEqual([]);
    expect(selection.dropped.every((d) => d.reason === 'instruction_over_budget')).toBe(true);
  });

  it('uses a fallback question when the case type is blank, without changing the selection rule', () => {
    expect(selectGroundedSources(sources, '   ', generous).sources).toHaveLength(3);
  });
});

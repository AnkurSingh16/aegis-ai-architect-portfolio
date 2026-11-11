import { describe, expect, it } from 'vitest';
import { syntheticCases } from '../../contracts/triage.js';
import { groundedContextDatasetVersion, groundedContextScenarios, groundedContextSlots, resolveGroundedContextSource,
  type GroundedContextScenario } from './grounded-context-dataset.js';
import { groundedContextEvaluationReportRelativePath, groundedEvaluationV1ReportRelativePath,
  groundedEvaluationV2ReportRelativePath, groundedEvaluationV3ReportRelativePath } from './run-grounded-local-evaluation.js';

describe('versioned context-complete grounded dataset', () => {
  it('keeps model facts separate from private expected-label review notes', () => {
    expect(groundedContextDatasetVersion).toBe('aegis-grounded-context-v1');
    expect(groundedContextSlots).toHaveLength(6);
    expect(groundedContextSlots.map((slot) => slot.caseFacts)).toEqual(groundedContextSlots.map((slot) =>
      syntheticCases.find((item) => item.id === slot.caseId)?.description));
    expect(groundedContextScenarios.every((scenario) => scenario.expectedGroundingState === 'INSUFFICIENT_EVIDENCE' && scenario.expected === null)).toBe(true);
    expect(groundedContextScenarios.map((scenario) => scenario.caseId)).toEqual([
      'SYNTHETIC-LOGIN-001', 'SYNTHETIC-BILLING-002', 'SYNTHETIC-GUIDANCE-003',
    ]);
  });

  it('binds each in-memory evaluation source to the same explicit tenant', () => {
    for (const scenario of groundedContextScenarios) expect(resolveGroundedContextSource(scenario).tenant).toBe(scenario.tenant);
    const wrongTenant = { ...groundedContextScenarios[1]!, tenant: 'north' as const };
    expect(() => resolveGroundedContextSource(wrongTenant)).toThrow(/tenant and revision/);
    const wrongVersion = { ...groundedContextScenarios[1]!, sourceVersion: 2 } as unknown as GroundedContextScenario;
    expect(() => resolveGroundedContextSource(wrongVersion)).toThrow(/tenant and revision/);
  });

  it('uses a fresh exclusive report path without reusing historical versions', () => {
    expect(groundedContextEvaluationReportRelativePath).toBe('.local/evaluations/milestone-4.11-grounded-context-qwen2.5-3b-instruct-v1.json');
    expect(new Set([groundedContextEvaluationReportRelativePath, groundedEvaluationV1ReportRelativePath,
      groundedEvaluationV2ReportRelativePath, groundedEvaluationV3ReportRelativePath]).size).toBe(4);
  });
});

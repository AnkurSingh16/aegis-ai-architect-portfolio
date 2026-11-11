import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { groundedBalancedDatasetVersion, groundedBalancedScenarios, groundedBalancedSourceRevision,
  validateGroundedBalancedDataset } from './grounded-balanced-dataset.js';
import { groundedBalancedReportRelativePath } from './run-grounded-balanced-local-evaluation.js';
import { groundedContextEvaluationReportRelativePath, groundedEvaluationV1ReportRelativePath,
  groundedEvaluationV2ReportRelativePath, groundedEvaluationV3ReportRelativePath } from './run-grounded-local-evaluation.js';

const digest = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');

describe('balanced grounded synthetic dataset', () => {
  it('defines six distinct cases with three supported and three evidence-based abstentions', () => {
    validateGroundedBalancedDataset();
    expect(groundedBalancedDatasetVersion).toBe('aegis-grounded-balanced-v1');
    expect(groundedBalancedScenarios).toHaveLength(6);
    expect(new Set(groundedBalancedScenarios.map((item) => item.scenarioId)).size).toBe(6);
    expect(new Set(groundedBalancedScenarios.map((item) => item.caseFacts)).size).toBe(6);
    expect(groundedBalancedScenarios.filter((item) => item.expectedGroundingState === 'SUPPORTED' && item.expected !== null)).toHaveLength(3);
    expect(groundedBalancedScenarios.filter((item) => item.expectedGroundingState === 'INSUFFICIENT_EVIDENCE' && item.expected === null)).toHaveLength(3);
    expect(groundedBalancedScenarios.map((item) => item.caseType)).toEqual(['login', 'login', 'billing', 'billing', 'guidance', 'guidance']);
    expect(groundedBalancedScenarios.every((item) => item.reviewRationale.length > 0)).toBe(true);
  });

  it('validates tenant ownership, revision, version, and content hashes for evaluation-only sources', () => {
    expect(groundedBalancedSourceRevision).toBe('aegis-balanced-eval-docs-v1');
    for (const scenario of groundedBalancedScenarios) {
      for (const source of scenario.sources) {
        expect(source.tenant).toBe(scenario.tenant);
        expect(source.version).toBe(1);
        expect(source.sourceRevision).toBe(groundedBalancedSourceRevision);
        expect(source.contentSha256).toBe(digest(source.content));
      }
      if (scenario.expected) expect(scenario.expectedSourceIdentities.every((id) => scenario.sources.some((source) => source.sourceIdentity === id))).toBe(true);
    }
    const changed = groundedBalancedScenarios.map((item, index) => index ? item : { ...item, caseFacts: `${item.caseFacts} modified` });
    expect(() => validateGroundedBalancedDataset(changed)).toThrow(/dataset is invalid/);
    const foreignSource = groundedBalancedScenarios.map((item, index) => index ? item : { ...item,
      expectedSourceIdentities: item.expectedSourceIdentities.map((identity, sourceIndex) => sourceIndex ? identity : 'EVAL-SOUTH-LOGIN-SCOPE-V1'),
      sources: item.sources.map((source, sourceIndex) => sourceIndex ? source : { ...source, sourceIdentity: 'EVAL-SOUTH-LOGIN-SCOPE-V1' }) });
    expect(() => validateGroundedBalancedDataset(foreignSource)).toThrow(/provenance is invalid/);
  });

  it('uses a fresh report identity and leaves the V4 and historical report paths distinct', () => {
    expect(groundedBalancedReportRelativePath).toBe('.local/evaluations/milestone-4.12-grounded-balanced-qwen2.5-3b-instruct-v1.json');
    expect(new Set([groundedBalancedReportRelativePath, groundedContextEvaluationReportRelativePath,
      groundedEvaluationV1ReportRelativePath, groundedEvaluationV2ReportRelativePath, groundedEvaluationV3ReportRelativePath]).size).toBe(5);
  });
});

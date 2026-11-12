import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { recommendedActions } from '../analysis.js';
import { parseGroundedProviderOutput, GroundedOutputError, type GroundedSource } from '../grounded-analysis.js';
import { groundedBalancedScenarios } from './grounded-balanced-dataset.js';
import { auditGroundedEvidence, groundedEvidenceAuditReviewStatus, groundedEvidenceFixtureFingerprint,
  GroundedEvidenceAuditError, type GroundedEvidenceAuditScenario } from './grounded-evidence-audit.js';

const expectedScenarioIds = [
  'BALANCED-LOGIN-201', 'BALANCED-LOGIN-202', 'BALANCED-BILLING-301',
  'BALANCED-BILLING-302', 'BALANCED-GUIDANCE-401', 'BALANCED-GUIDANCE-402',
] as const;

const expectedFingerprint = [
  ['BALANCED-LOGIN-201', 'e99510206ccc6f65871d69698624a645000b741664dcc06880b5708cb371d43b', [
    ['EVAL-NORTH-LOGIN-SEVERITY-V1', 1, 'aegis-balanced-eval-docs-v1', '36f4293069f95f8ff6a77b5b9f5baa8b202bd6459a13559091794356906b565e'],
    ['EVAL-NORTH-LOGIN-STATUS-V1', 1, 'aegis-balanced-eval-docs-v1', 'a3469b2c69276accae48b3634316d6ff6fcb5ff8ec81f2a72ba1637f42aa477f'],
  ]],
  ['BALANCED-LOGIN-202', 'd047d12f9a59f956dc3a7a8f6f28d03db998195aa08e448c237bc6658828e57f', [
    ['EVAL-SOUTH-LOGIN-SCOPE-V1', 1, 'aegis-balanced-eval-docs-v1', '2340d75d179a09897eaf1346d631e2fe994464e5955aa73dfba9e614ac44de24'],
    ['EVAL-SOUTH-LOGIN-STATUS-V1', 1, 'aegis-balanced-eval-docs-v1', '9a8d82291a91c31dd6a536995ebb237d2b6f364ab300c71546f0ed2a2e30644e'],
  ]],
  ['BALANCED-BILLING-301', 'ca1f1480bab7e8a15b8bd51373bdcb393d30331a35ab26d01aab343cd5d49f27', [
    ['EVAL-SOUTH-BILLING-REVIEW-V1', 1, 'aegis-balanced-eval-docs-v1', 'e99d4583ce1ef36f4469275153a2fc7b5260a4a65fea668e0f09fb87a75a57cc'],
    ['EVAL-SOUTH-BILLING-LEDGER-V1', 1, 'aegis-balanced-eval-docs-v1', 'b1971d6c6da041714a4c50f1de8993bf32fac8dea67e9e78de884193efcff06b'],
    ['EVAL-SOUTH-BILLING-STATUS-V1', 1, 'aegis-balanced-eval-docs-v1', '066f56dc4418907c35ae3df12550d0df2266e06da2cbfddd559cb7c451716503'],
  ]],
  ['BALANCED-BILLING-302', 'a207256df295272e865bb06df865b0560c478854c8bc637f5dd22ce120e8c035', [
    ['EVAL-NORTH-BILLING-REQUIREMENTS-V1', 1, 'aegis-balanced-eval-docs-v1', '59b6e655e8e5825a5f19f69eee71c9144bda9f92875dbc11e793d36fbae17d8a'],
    ['EVAL-NORTH-BILLING-LEDGER-V1', 1, 'aegis-balanced-eval-docs-v1', 'eeab3b73dcebe25bf3be67b0af03801889f917f00ab3b49abcbf74d4ec8be5cd'],
  ]],
  ['BALANCED-GUIDANCE-401', 'ae4fa4659654799c27d1f63cf9f2a8879394814979589359df94dd2c87f57ffa', [
    ['EVAL-NORTH-GUIDANCE-INDEX-V1', 1, 'aegis-balanced-eval-docs-v1', 'b3354041ae95e8ae9fa3bc69766e7d4bc9dcfd8847736910885447a3ee93f398'],
    ['EVAL-NORTH-GUIDANCE-ROUTING-V1', 1, 'aegis-balanced-eval-docs-v1', '993243535b308286f783b30511a3cde3479c7a4698ead75e4d6424da98b507e1'],
  ]],
  ['BALANCED-GUIDANCE-402', '6f885d455c177fd00110d8efb9a4adf86a2f3160361c2cd8a03348c02f1cdf83', [
    ['EVAL-SOUTH-GUIDANCE-INDEX-V1', 1, 'aegis-balanced-eval-docs-v1', '093d7877f9baaab691f2b5c6e8818bfbcc4f0dd2c6f92a241b2bd08e36c60a6f'],
    ['EVAL-SOUTH-GUIDANCE-BOUNDARY-V1', 1, 'aegis-balanced-eval-docs-v1', '4519b88fc5da00c4a87e7e785ce89586d00b8b1ebbc660dfd41226cb89cad728'],
  ]],
] as const;

const inputFor = (scenarios: readonly unknown[] = groundedBalancedScenarios): readonly GroundedEvidenceAuditScenario[] =>
  scenarios as readonly GroundedEvidenceAuditScenario[];
const contentHash = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex');
const scenarioById = (id: string) => auditGroundedEvidence().scenarios.find((item) => item.scenarioId === id)!;
const sourceInput = (): GroundedSource => ({ citationId: '123e4567-e89b-42d3-a456-426614174000', title: 'Synthetic source',
  sourceIdentity: 'SYNTHETIC-TEST-SOURCE', version: 1, position: 0, content: 'Synthetic evidence.' });

function expectAuditReason(callback: () => unknown, reason: GroundedEvidenceAuditError['reason']): void {
  try { callback(); expect.fail('expected deterministic audit validation to reject the input'); }
  catch (error) {
    expect(error).toBeInstanceOf(GroundedEvidenceAuditError);
    expect((error as GroundedEvidenceAuditError).reason).toBe(reason);
  }
}

function expectOutputReason(callback: () => unknown, reason: GroundedOutputError['validationReason']): void {
  try { callback(); expect.fail('expected the strict parser to reject the output'); }
  catch (error) {
    expect(error).toBeInstanceOf(GroundedOutputError);
    expect((error as GroundedOutputError).validationReason).toBe(reason);
  }
}

function supportedOutput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { groundingState: 'SUPPORTED', category: 'incident', priority: 'high', recommendedTeam: 'Platform support',
    rationale: 'The synthetic service impact meets the documented threshold.',
    nextAction: recommendedActions[0], citations: [sourceInput().citationId], confidence: 0.5, uncertainty: 'moderate',
    humanReviewRequired: true, ...overrides };
}

describe('deterministic grounded evidence audit', () => {
  it('audits exactly six fixed scenarios without reading expected labels or rationales', () => {
    const result = auditGroundedEvidence();
    expect(result.diagnosticOnly).toBe(true);
    expect(result.reviewStatus).toBe(groundedEvidenceAuditReviewStatus);
    expect(result.reviewStatus).toBe('engineering_reviewed_pending_independent_review');
    expect(result.scenarios.map((item) => item.scenarioId)).toEqual(expectedScenarioIds);
    expect(result.scenarios.every((item) => item.humanReview.required)).toBe(true);
    expect(result.scenarios.every((item) => item.assessmentOnlyOutputs.every((output) =>
      output.state === 'NOT_APPLICABLE' && !('value' in output)))).toBe(true);

    const alteredAnswerKey = groundedBalancedScenarios.map((scenario) => ({ ...scenario,
      expected: { category: 'guidance', priority: 'low', recommendedTeam: 'Customer support', nextAction: recommendedActions[2] },
      expectedGroundingState: 'INSUFFICIENT_EVIDENCE' as const,
      reviewRationale: 'LEAK_SENTINEL_RATIONALE',
    }));
    expect(auditGroundedEvidence(inputFor(alteredAnswerKey))).toEqual(result);
    expect(JSON.stringify(result)).not.toContain('LEAK_SENTINEL_RATIONALE');
    expect(JSON.stringify(result)).not.toContain('Platform support');
    expect(JSON.stringify(result)).not.toContain('incident');
    expect(JSON.stringify(result)).not.toContain('insufficient evidence');
  });

  it('pins all six scenario identities and all existing fact/source hashes and revisions', () => {
    expect(groundedEvidenceFixtureFingerprint()).toEqual(expectedFingerprint.map(([scenarioId, caseFactsSha256, sources]) => ({
      scenarioId, caseFactsSha256, sources: sources.map(([sourceIdentity, version, sourceRevision, contentSha256]) => ({
        sourceIdentity, version, sourceRevision, contentSha256,
      })),
    })));
    const factsDigest = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');
    for (const scenario of groundedBalancedScenarios) {
      expect(factsDigest(scenario.caseFacts)).toBe(scenario.caseFactsSha256);
      for (const source of scenario.sources) expect(factsDigest(source.content)).toBe(source.contentSha256);
    }
  });

  it('records field references, explicit taxonomy mapping, missing evidence, and source provenance separately', () => {
    const login = scenarioById('BALANCED-LOGIN-201');
    expect(login.evidence.find((item) => item.field === 'category')?.state).toBe('TAXONOMY_MAPPING_REQUIRED');
    expect(login.evidence.find((item) => item.field === 'priority')?.state).toBe('EXPLICIT_SUPPORT');
    expect(login.evidence.find((item) => item.field === 'priority')?.references.map((ref) => ref.kind)).toContain('case_facts');
    expect(login.evidence).toHaveLength(5);
    expect(login.sourceProvenance.state).toBe('EXPLICIT_SUPPORT');
    expect(login.sourceRevisionConsistency.versions).toEqual([1]);

    const billingMissing = scenarioById('BALANCED-BILLING-302');
    expect(billingMissing.missingEvidence).toEqual(['Invoice identifiers', 'Billing period', 'Line-item totals', 'Approved ledger lookup result']);
    expect(billingMissing.evidence.find((item) => item.field === 'priority')?.state).toBe('MISSING_EVIDENCE');
    expect(scenarioById('BALANCED-GUIDANCE-402').taxonomyMappingRequirements).toHaveLength(1);
  });

  it('rejects missing, duplicate, or unexpected scenario identities', () => {
    expectAuditReason(() => auditGroundedEvidence(inputFor(groundedBalancedScenarios.slice(1))), 'invalid_scenario_set');
    const duplicate = [...groundedBalancedScenarios];
    duplicate[1] = { ...duplicate[1]!, scenarioId: duplicate[0]!.scenarioId };
    expectAuditReason(() => auditGroundedEvidence(inputFor(duplicate)), 'invalid_scenario_set');
    const renamed = groundedBalancedScenarios.map((item, index) => index ? item : { ...item, scenarioId: 'BALANCED-LOGIN-999' });
    expectAuditReason(() => auditGroundedEvidence(inputFor(renamed)), 'invalid_scenario_set');
  });

  it('fails closed on case-fact integrity and synthetic source provenance mismatches', () => {
    const badFacts = groundedBalancedScenarios.map((item, index) => index ? item : { ...item, caseFacts: `${item.caseFacts} tampered` });
    expectAuditReason(() => auditGroundedEvidence(inputFor(badFacts)), 'case_facts_hash_mismatch');

    const wrongTenant = groundedBalancedScenarios.map((item, index) => index ? item : { ...item,
      sources: item.sources.map((source, sourceIndex) => sourceIndex ? source : { ...source, tenant: 'south' as const }) });
    expectAuditReason(() => auditGroundedEvidence(inputFor(wrongTenant)), 'source_tenant_mismatch');

    const wrongIdentity = groundedBalancedScenarios.map((item, index) => index ? item : { ...item,
      sources: item.sources.map((source, sourceIndex) => sourceIndex ? source : { ...source, sourceIdentity: 'EVAL-SOUTH-LOGIN-OTHER-V1' }) });
    expectAuditReason(() => auditGroundedEvidence(inputFor(wrongIdentity)), 'source_identity_mismatch');

    const wrongVersion = groundedBalancedScenarios.map((item, index) => index ? item : { ...item,
      sources: item.sources.map((source, sourceIndex) => sourceIndex ? source : { ...source, version: 2 as const }) });
    expectAuditReason(() => auditGroundedEvidence(inputFor(wrongVersion)), 'source_version_mismatch');

    const wrongRevision = groundedBalancedScenarios.map((item, index) => index ? item : { ...item,
      sources: item.sources.map((source, sourceIndex) => sourceIndex ? source : { ...source, sourceRevision: 'unreviewed' as never }) });
    expectAuditReason(() => auditGroundedEvidence(inputFor(wrongRevision)), 'source_revision_mismatch');

    const wrongHash = groundedBalancedScenarios.map((item, index) => index ? item : { ...item,
      sources: item.sources.map((source, sourceIndex) => sourceIndex ? source : { ...source, contentSha256: '0'.repeat(64) }) });
    expectAuditReason(() => auditGroundedEvidence(inputFor(wrongHash)), 'source_hash_mismatch');
  });

  it('rejects case facts changed with either the original or recomputed hash', () => {
    const changedWithOriginalHash = groundedBalancedScenarios.map((item, index) => index ? item :
      { ...item, caseFacts: `${item.caseFacts} unreviewed addition` });
    expectAuditReason(() => auditGroundedEvidence(inputFor(changedWithOriginalHash)), 'case_facts_hash_mismatch');

    const changedWithRecomputedHash = groundedBalancedScenarios.map((item, index) => {
      if (index) return item;
      const caseFacts = `${item.caseFacts} unreviewed addition`;
      return { ...item, caseFacts, caseFactsSha256: contentHash(caseFacts) };
    });
    expectAuditReason(() => auditGroundedEvidence(inputFor(changedWithRecomputedHash)), 'unreviewed_fixture_change');
  });

  it('rejects source content changed with either the original or recomputed hash', () => {
    const changedWithOriginalHash = groundedBalancedScenarios.map((item, index) => index ? item : ({ ...item,
      sources: item.sources.map((source, sourceIndex) => sourceIndex ? source : { ...source, content: `${source.content} unreviewed addition` }) }));
    expectAuditReason(() => auditGroundedEvidence(inputFor(changedWithOriginalHash)), 'source_hash_mismatch');

    const changedWithRecomputedHash = groundedBalancedScenarios.map((item, index) => index ? item : ({ ...item,
      sources: item.sources.map((source, sourceIndex) => {
        if (sourceIndex) return source;
        const content = `${source.content} unreviewed addition`;
        return { ...source, content, contentSha256: contentHash(content) };
      }) }));
    expectAuditReason(() => auditGroundedEvidence(inputFor(changedWithRecomputedHash)), 'unreviewed_fixture_change');
  });

  it('rejects changed source titles, valid-looking replacement identities, and reordered sources', () => {
    const changedTitle = groundedBalancedScenarios.map((item, index) => index ? item : ({ ...item,
      sources: item.sources.map((source, sourceIndex) => sourceIndex ? source : { ...source, title: 'Rewritten synthetic title' }) }));
    expectAuditReason(() => auditGroundedEvidence(inputFor(changedTitle)), 'unreviewed_fixture_change');

    const changedIdentity = groundedBalancedScenarios.map((item, index) => index ? item : ({ ...item,
      sources: item.sources.map((source, sourceIndex) => sourceIndex ? source : { ...source, sourceIdentity: 'EVAL-NORTH-LOGIN-REPLACEMENT-V1' }) }));
    expectAuditReason(() => auditGroundedEvidence(inputFor(changedIdentity)), 'unreviewed_fixture_change');

    const reordered = groundedBalancedScenarios.map((item, index) => index ? item : ({ ...item, sources: [...item.sources].reverse() }));
    expectAuditReason(() => auditGroundedEvidence(inputFor(reordered)), 'unreviewed_fixture_change');
  });

  it('rejects a changed scenario tenant even when its sources share that changed tenant', () => {
    const changedTenant = groundedBalancedScenarios.map((item, index) => index ? item : ({ ...item, tenant: 'south' as const,
      sources: item.sources.map((source, sourceIndex) => ({ ...source, tenant: 'south' as const,
        sourceIdentity: sourceIndex === 0 ? 'EVAL-SOUTH-LOGIN-201-SEVERITY-V1' : 'EVAL-SOUTH-LOGIN-201-STATUS-V1' })) }));
    expectAuditReason(() => auditGroundedEvidence(inputFor(changedTenant)), 'unreviewed_fixture_change');
  });

  it('rejects evidence references to absent sources and duplicate source identities', () => {
    const missingReference = groundedBalancedScenarios.map((item, index) => index ? item : { ...item, sources: item.sources.slice(1) });
    expectAuditReason(() => auditGroundedEvidence(inputFor(missingReference)), 'unreviewed_fixture_change');

    const duplicateIdentity = groundedBalancedScenarios.map((item, index) => index ? item : { ...item,
      sources: item.sources.map((source, sourceIndex) => sourceIndex ? source : { ...source, sourceIdentity: 'EVAL-NORTH-LOGIN-STATUS-V1' }) });
    expectAuditReason(() => auditGroundedEvidence(inputFor(duplicateIdentity)), 'duplicate_source_identity');
  });
});

describe('existing grounded output contract remains authoritative', () => {
  it.each([0, 0.5, 1])('accepts supported confidence boundary %s', (confidence) => {
    expect(parseGroundedProviderOutput(supportedOutput({ confidence }), [sourceInput()])).toMatchObject({ groundingState: 'SUPPORTED', confidence });
  });

  it.each([1.01, -0.01, '0.5', null, Number.POSITIVE_INFINITY])('rejects invalid supported confidence %s without coercion', (confidence) => {
    expect(() => parseGroundedProviderOutput(supportedOutput({ confidence }), [sourceInput()])).toThrowError(GroundedOutputError);
  });

  it('rejects missing confidence instead of filling it', () => {
    const output = supportedOutput();
    delete output.confidence;
    expectOutputReason(() => parseGroundedProviderOutput(output, [sourceInput()]), 'missing_required_field');
  });

  it('accepts only the canonical insufficient-evidence shape with mandatory review', () => {
    const abstention = { groundingState: 'INSUFFICIENT_EVIDENCE', category: null, priority: null, recommendedTeam: null,
      rationale: null, nextAction: null, citations: [], confidence: null, uncertainty: 'high', humanReviewRequired: true };
    expect(parseGroundedProviderOutput(abstention, [sourceInput()])).toMatchObject({ groundingState: 'INSUFFICIENT_EVIDENCE', citations: [] });
    expectOutputReason(() => parseGroundedProviderOutput({ ...abstention, confidence: 0.2 }, [sourceInput()]), 'invalid_state_combination');
    expectOutputReason(() => parseGroundedProviderOutput({ ...abstention, humanReviewRequired: false }, [sourceInput()]), 'invalid_human_review');
  });

  it('rejects duplicate, unknown, and empty citations without repairing them', () => {
    const citation = sourceInput().citationId;
    expectOutputReason(() => parseGroundedProviderOutput(supportedOutput({ citations: [citation, citation] }), [sourceInput()]), 'duplicate_citation');
    expectOutputReason(() => parseGroundedProviderOutput(supportedOutput({ citations: ['123e4567-e89b-42d3-a456-426614174001'] }), [sourceInput()]), 'unknown_citation');
    expectOutputReason(() => parseGroundedProviderOutput(supportedOutput({ citations: [] }), [sourceInput()]), 'missing_citation');
  });

  it('keeps this module isolated from providers, database clients, and report writes', () => {
    const source = readFileSync(fileURLToPath(new URL('./grounded-evidence-audit.ts', import.meta.url)), 'utf8');
    expect(source).toContain("from './grounded-balanced-dataset.js'");
    expect(source).not.toMatch(/grounded-provider|fetch\s*\(|node:fs|reservePrivateReport|writeFile/);
  });

  it('keeps expected labels and review rationales out of the balanced runner provider input', () => {
    const runner = readFileSync(fileURLToPath(new URL('./grounded-balanced-runner.ts', import.meta.url)), 'utf8');
    const providerInput = /provider\.analyze\(\{([^}]+)\}/s.exec(runner)?.[1];
    expect(providerInput).toBeDefined();
    expect(providerInput).toContain('caseType: scenario.caseType');
    expect(providerInput).toContain('caseFacts: scenario.caseFacts');
    expect(providerInput).toContain('sources: bundle.sources');
    expect(providerInput).not.toMatch(/expected|reviewRationale/);
  });
});

import { syntheticCases, type SyntheticCaseId } from '../../contracts/triage.js';
import type { StoredCase } from '../../storage/models.js';
import { recommendedActions } from '../analysis.js';

export const evaluationDatasetVersion = 'aegis-synthetic-case-eval-v1';
export const evaluationLabelStatus = 'engineering-reviewed-not-human-approved' as const;
const northFixtureTenant = '10000000-0000-4000-8000-000000000001';

export interface ExpectedCaseLabels {
  category: 'incident' | 'billing' | 'guidance';
  priority: 'high' | 'medium' | 'low';
  recommendedTeam: 'Platform support' | 'Billing support' | 'Customer support';
  nextAction: typeof recommendedActions[number];
}

export interface EvaluationCase {
  id: string;
  caseType: SyntheticCaseId;
  kind: 'canonical' | 'timestamp-pair';
  storedCase: StoredCase;
  expected: ExpectedCaseLabels;
  rationale: string;
}

const labels: Record<SyntheticCaseId, ExpectedCaseLabels> = {
  'SYNTHETIC-LOGIN-001': {
    category: 'incident', priority: 'high', recommendedTeam: 'Platform support', nextAction: recommendedActions[0],
  },
  'SYNTHETIC-BILLING-002': {
    category: 'billing', priority: 'medium', recommendedTeam: 'Billing support', nextAction: recommendedActions[1],
  },
  'SYNTHETIC-GUIDANCE-003': {
    category: 'guidance', priority: 'low', recommendedTeam: 'Customer support', nextAction: recommendedActions[2],
  },
};
const labelRationale: Record<SyntheticCaseId, string> = {
  'SYNTHETIC-LOGIN-001': 'The invented workspace-wide 503 sign-in failure is an active service incident; high priority and Platform support match the stated impact.',
  'SYNTHETIC-BILLING-002': 'The invented duplicate invoice is a billing discrepancy; medium priority and Billing support match the financial issue without claiming account-wide outage.',
  'SYNTHETIC-GUIDANCE-003': 'The invented request asks for onboarding documentation; low priority and Customer support fit an informational request.',
};

function storedCase(caseType: SyntheticCaseId, suffix: string, timestamp: string): StoredCase {
  const instant = new Date(timestamp);
  return {
    id: `20000000-0000-4000-8000-${suffix}`,
    tenant_id: northFixtureTenant,
    synthetic_case_id: caseType,
    status: 'in_progress',
    created_at: new Date(instant),
    updated_at: new Date(instant),
  };
}

const canonicalTimestamp = '2026-10-28T04:23:00.256Z';
const pairedTimestamp = '2026-11-01T12:00:00.000Z';

/** All labels and rationale are fixed before any local-model evaluation. */
export const evaluationCases: readonly EvaluationCase[] = syntheticCases.flatMap((fixture, index) => {
  const canonical = {
    id: `${fixture.id.toLowerCase()}-canonical`, caseType: fixture.id, kind: 'canonical' as const,
    storedCase: storedCase(fixture.id, `00000000000${index + 1}`, canonicalTimestamp),
    expected: labels[fixture.id],
    rationale: `${labelRationale[fixture.id]} Labels are engineering-reviewed, not human-approved ground truth.`,
  };
  const paired = {
    id: `${fixture.id.toLowerCase()}-timestamp-pair`, caseType: fixture.id, kind: 'timestamp-pair' as const,
    storedCase: storedCase(fixture.id, `00000000000${index + 1}`, pairedTimestamp),
    expected: labels[fixture.id],
    rationale: `${labelRationale[fixture.id]} This is a timestamp-only paired observation; status and narrative are unchanged, so the predeclared labels remain the same. It is not an independent case. Labels are engineering-reviewed, not human-approved ground truth.`,
  };
  return [canonical, paired];
});

export type ContractProbeId = 'unsupported-evidence' | 'duplicate-evidence' | 'unsafe-rationale' |
  'unsupported-action' | 'human-review-disabled' | 'missing-evidence';

/** Derived contract probes stay in deterministic tests; they are never sent to the model. */
export const derivedContractProbes: readonly { id: ContractProbeId; purpose: string; schemaReason: string; evidenceReason?: string }[] = [
  { id: 'unsupported-evidence', purpose: 'Reject an evidence field outside the fixed case-field allowlist.', schemaReason: 'invalid_evidence_references', evidenceReason: 'invalid_identifier' },
  { id: 'duplicate-evidence', purpose: 'Reject duplicate evidence references.', schemaReason: 'invalid_evidence_references', evidenceReason: 'duplicate_identifier' },
  { id: 'unsafe-rationale', purpose: 'Reject unsafe instruction or action language in rationale.', schemaReason: 'unsafe_rationale' },
  { id: 'unsupported-action', purpose: 'Reject a next action outside the approved fixed set.', schemaReason: 'invalid_next_action' },
  { id: 'human-review-disabled', purpose: 'Reject output that does not require human review.', schemaReason: 'invalid_human_review' },
  { id: 'missing-evidence', purpose: 'Reject empty evidence references.', schemaReason: 'invalid_evidence_references', evidenceReason: 'empty_array' },
];

/** Exactly two predeclared provider-level slots per canonical case type. */
export const plannedEvaluationSlots: readonly EvaluationCase[] = evaluationCases;

export const plannedEvaluationSlotCount = 6;

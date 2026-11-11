import { syntheticCases, type SyntheticCaseId } from '../../contracts/triage.js';
import { syntheticDocuments, type SyntheticDocument } from '../../documents/catalog.js';
import type { ExpectedCaseLabels } from './dataset.js';

export const groundedContextDatasetVersion = 'aegis-grounded-context-v1';
export const groundedContextLabelStatus = 'engineering-reviewed-not-human-approved' as const;
export const groundedContextSourceRevision = 'aegis-support-docs-v1';

export interface GroundedContextScenario {
  caseId: SyntheticCaseId;
  caseFacts: string;
  tenant: SyntheticDocument['tenant'];
  sourceIdentity: string;
  sourceVersion: 1;
  expectedGroundingState: 'SUPPORTED' | 'INSUFFICIENT_EVIDENCE';
  /** Classification labels are deliberately absent for abstention-only scenarios. */
  expected: Partial<ExpectedCaseLabels> | null;
  reviewRationale: string;
}

const scenarioDefinitions: readonly Omit<GroundedContextScenario, 'caseFacts'>[] = [
  { caseId: 'SYNTHETIC-LOGIN-001', tenant: 'north', sourceIdentity: 'SYNTHETIC-NORTH-LOGIN-INCIDENT', sourceVersion: 1,
    expectedGroundingState: 'INSUFFICIENT_EVIDENCE', expected: null,
    reviewRationale: 'The fixture describes broad sign-in impact, but the source requires scope verification and provides no reviewed severity or team-assignment criteria. The complete supported output is therefore not established.' },
  { caseId: 'SYNTHETIC-BILLING-002', tenant: 'south', sourceIdentity: 'SYNTHETIC-SOUTH-BILLING-DISCREPANCY', sourceVersion: 1,
    expectedGroundingState: 'INSUFFICIENT_EVIDENCE', expected: null,
    reviewRationale: 'The fixture reports duplicate invoices but supplies no invoice identifier, line-item totals, or period for the source-mandated comparison. Priority and a correction recommendation cannot be supported.' },
  { caseId: 'SYNTHETIC-GUIDANCE-003', tenant: 'south', sourceIdentity: 'SYNTHETIC-SOUTH-GENERAL-GUIDANCE', sourceVersion: 1,
    expectedGroundingState: 'INSUFFICIENT_EVIDENCE', expected: null,
    reviewRationale: 'The fixture asks where to find an onboarding guide, while the selected source does not identify a location. A specific answer would require an additional reviewed source.' },
];

const factsById = new Map(syntheticCases.map((item) => [item.id, item.description]));

/** Versioned, source-backed evaluation inputs. Facts and labels remain separate objects. */
export const groundedContextScenarios: readonly GroundedContextScenario[] = Object.freeze(scenarioDefinitions.map((scenario) => {
  const caseFacts = factsById.get(scenario.caseId);
  if (!caseFacts) throw new Error('Grounded context dataset references an unknown synthetic case.');
  return Object.freeze({ ...scenario, caseFacts });
}));

export interface GroundedContextSlot extends GroundedContextScenario {
  slotId: string;
}

/** Two repeated provider observations per canonical case; repeats are not independent cases. */
export const groundedContextSlots: readonly GroundedContextSlot[] = Object.freeze(groundedContextScenarios.flatMap((scenario) => [
  Object.freeze({ ...scenario, slotId: `${scenario.caseId.toLowerCase()}-context-1` }),
  Object.freeze({ ...scenario, slotId: `${scenario.caseId.toLowerCase()}-context-2` }),
]));

export function resolveGroundedContextSource(scenario: GroundedContextScenario): SyntheticDocument {
  const source = syntheticDocuments.find((item) => item.sourceIdentity === scenario.sourceIdentity);
  if (!source || source.tenant !== scenario.tenant || source.version !== scenario.sourceVersion ||
      source.sourceRevision !== groundedContextSourceRevision) {
    throw new Error('Grounded context source does not match its approved tenant and revision.');
  }
  return source;
}

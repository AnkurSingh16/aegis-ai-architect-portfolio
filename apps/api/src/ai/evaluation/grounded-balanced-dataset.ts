import { createHash } from 'node:crypto';
import type { ExpectedCaseLabels } from './dataset.js';
import { recommendedActions } from '../analysis.js';
import { categories, priorities, suggestedTeams } from '../../contracts/triage.js';

export const groundedBalancedDatasetVersion = 'aegis-grounded-balanced-v1';
export const groundedBalancedLabelStatus = 'engineering-reviewed-not-human-approved' as const;
export const groundedBalancedSourceRevision = 'aegis-balanced-eval-docs-v1';
export const groundedBalancedCaseProvenance = 'source-controlled-invented-synthetic-cases-v1';

export interface BalancedSourceFixture {
  sourceIdentity: string;
  tenant: 'north' | 'south';
  version: 1;
  sourceRevision: typeof groundedBalancedSourceRevision;
  sourceOwner: 'Aegis synthetic evaluation corpus';
  title: string;
  content: string;
  contentSha256: string;
}

export interface GroundedBalancedScenario {
  scenarioId: string;
  caseType: 'login' | 'billing' | 'guidance';
  tenant: 'north' | 'south';
  caseProvenance: typeof groundedBalancedCaseProvenance;
  caseFacts: string;
  caseFactsSha256: string;
  sources: readonly BalancedSourceFixture[];
  expectedGroundingState: 'SUPPORTED' | 'INSUFFICIENT_EVIDENCE';
  expected: ExpectedCaseLabels | null;
  expectedSourceIdentities: readonly string[];
  reviewRationale: string;
}

const hash = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex');

function source(sourceIdentity: string, tenant: BalancedSourceFixture['tenant'], title: string, content: string): BalancedSourceFixture {
  return Object.freeze({ sourceIdentity, tenant, version: 1, sourceRevision: groundedBalancedSourceRevision,
    sourceOwner: 'Aegis synthetic evaluation corpus', title, content, contentSha256: hash(content) });
}

const labels = {
  login: { category: 'incident', priority: 'high', recommendedTeam: 'Platform support',
    nextAction: recommendedActions[0] },
  billing: { category: 'billing', priority: 'medium', recommendedTeam: 'Billing support',
    nextAction: recommendedActions[1] },
  guidance: { category: 'guidance', priority: 'low', recommendedTeam: 'Customer support',
    nextAction: recommendedActions[2] },
} as const satisfies Record<GroundedBalancedScenario['caseType'], ExpectedCaseLabels>;

function scenario(input: Omit<GroundedBalancedScenario, 'caseFactsSha256' | 'caseProvenance'>): GroundedBalancedScenario {
  return Object.freeze({ ...input, sources: Object.freeze([...input.sources]),
    expectedSourceIdentities: Object.freeze([...input.expectedSourceIdentities]),
    expected: input.expected ? Object.freeze({ ...input.expected }) : null,
    caseProvenance: groundedBalancedCaseProvenance, caseFactsSha256: hash(input.caseFacts) });
}

/** Evaluation-only invented documents. They are not part of the production ingestion catalog. */
export const groundedBalancedScenarios: readonly GroundedBalancedScenario[] = Object.freeze([
  scenario({ scenarioId: 'BALANCED-LOGIN-201', caseType: 'login', tenant: 'north',
    caseFacts: 'The Synthetic North training workspace has 12 test accounts; all 12 of 12 continuously received HTTP 503 responses during sign-in for 24 minutes. The synthetic status check identifies the sign-in service as unavailable. No real users or systems are involved.',
    sources: [
      source('EVAL-NORTH-LOGIN-SEVERITY-V1', 'north', 'Synthetic sign-in severity criteria',
        'For this invented evaluation only: classify a sign-in service interruption as high priority when every test account in the tenant is blocked for more than 15 minutes and the approved synthetic status check confirms service unavailability. The sign-in service is owned by Platform support. The permitted advisory next action is “Review the synthetic service impact and incident timeline.” The reviewer must verify the evidence; no escalation or case change is automatic.'),
      source('EVAL-NORTH-LOGIN-STATUS-V1', 'north', 'Synthetic sign-in status observation',
        'The invented Synthetic North status check for this scenario reports the sign-in service unavailable during the stated 24-minute window. It contains no real operational data.'),
    ],
    expectedGroundingState: 'SUPPORTED', expected: labels.login,
    expectedSourceIdentities: ['EVAL-NORTH-LOGIN-SEVERITY-V1', 'EVAL-NORTH-LOGIN-STATUS-V1'],
    reviewRationale: 'The case facts establish tenant-wide impact, duration above the explicit threshold, and a confirming synthetic status check. The source provides severity, owner, and advisory action criteria.' }),
  scenario({ scenarioId: 'BALANCED-LOGIN-202', caseType: 'login', tenant: 'south',
    caseFacts: 'One Synthetic South test account reports a failed sign-in. The affected-account count, duration, error code, and service status have not been established.',
    sources: [
      source('EVAL-SOUTH-LOGIN-SCOPE-V1', 'south', 'Synthetic sign-in scope requirements',
        'For an invented sign-in report, a reviewer must establish the affected-account count, duration, and approved service-status observation before assigning severity, service ownership, or a next investigation step. A single unverified report is not evidence of tenant-wide impact.'),
      source('EVAL-SOUTH-LOGIN-STATUS-V1', 'south', 'Synthetic sign-in status requirements',
        'The synthetic status-check procedure requires a recorded result for the relevant time window. This evaluation case has no such result. Never infer an outage from an unverified report.'),
    ],
    expectedGroundingState: 'INSUFFICIENT_EVIDENCE', expected: null, expectedSourceIdentities: [],
    reviewRationale: 'Scope, duration, and a status observation are missing, so priority, ownership, and a complete permitted action cannot all be supported.' }),
  scenario({ scenarioId: 'BALANCED-BILLING-301', caseType: 'billing', tenant: 'south',
    caseFacts: 'The invented Synthetic South account statement lists invoice SYN-INV-301-A and SYN-INV-301-B for the same subscription and period. Each lists the same $125.00 demonstration service line. The approved synthetic ledger confirms both invoice entries, and the synthetic service check reports no service disruption.',
    sources: [
      source('EVAL-SOUTH-BILLING-REVIEW-V1', 'south', 'Synthetic duplicate invoice criteria',
        'For this invented evaluation: a ledger-verified duplicate service line for one subscription and billing period, with a synthetic check showing no service disruption, is medium priority and owned by Billing support. The permitted advisory next action is “Compare the synthetic invoice records before taking any billing action.” A human billing specialist must verify the comparison; the assistant must not promise a refund or alter a balance.'),
      source('EVAL-SOUTH-BILLING-LEDGER-V1', 'south', 'Synthetic invoice ledger match',
        'The invented approved test ledger records both supplied invoice identifiers for the same demonstration subscription, period, and $125.00 service line. It confirms a duplicate entry. No real financial account is represented.'),
      source('EVAL-SOUTH-BILLING-STATUS-V1', 'south', 'Synthetic billing service status',
        'The invented service check for this billing scenario reports no service disruption during the stated duplicate-invoice period. No real operational data is represented.'),
    ],
    expectedGroundingState: 'SUPPORTED', expected: labels.billing,
    expectedSourceIdentities: ['EVAL-SOUTH-BILLING-REVIEW-V1', 'EVAL-SOUTH-BILLING-LEDGER-V1', 'EVAL-SOUTH-BILLING-STATUS-V1'],
    reviewRationale: 'Invoice identity, period, amount, and ledger confirmation are present; the criteria explicitly determine category ownership, medium priority, and the allowed comparison action.' }),
  scenario({ scenarioId: 'BALANCED-BILLING-302', caseType: 'billing', tenant: 'north',
    caseFacts: 'An invented account contact says they may have received a duplicate invoice. No invoice identifier, billing period, line-item amount, or ledger result is available.',
    sources: [
      source('EVAL-NORTH-BILLING-REQUIREMENTS-V1', 'north', 'Synthetic billing comparison requirements',
        'A billing reviewer must compare invoice identifiers, billing period, line-item totals, and the approved test ledger before confirming a duplicate or recommending a billing action. If these details are unavailable, the evidence does not establish a discrepancy, priority, or responsible team.'),
      source('EVAL-NORTH-BILLING-LEDGER-V1', 'north', 'Synthetic ledger lookup status',
        'No ledger lookup result is present for this invented case. Do not infer an invoice match, duplicate, refund, or balance change.'),
    ],
    expectedGroundingState: 'INSUFFICIENT_EVIDENCE', expected: null, expectedSourceIdentities: [],
    reviewRationale: 'The identifiers, period, totals, and ledger result required by the source are absent; a complete supported decision is not justified.' }),
  scenario({ scenarioId: 'BALANCED-GUIDANCE-401', caseType: 'guidance', tenant: 'north',
    caseFacts: 'An invented new Synthetic North training user asks how to enroll a demonstration MFA device. The user reports no sign-in failure or account-access problem.',
    sources: [
      source('EVAL-NORTH-GUIDANCE-INDEX-V1', 'north', 'Synthetic approved onboarding guide index',
        'The invented approved Synthetic North training guide is “MFA Onboarding Guide”, located in the local training portal under Learning / Account Setup / MFA Onboarding. Its steps are: open the training portal, select Account Setup, choose MFA Onboarding, then follow the demonstration-factor enrollment checklist. It does not request a real password or one-time code.'),
      source('EVAL-NORTH-GUIDANCE-ROUTING-V1', 'north', 'Synthetic informational request criteria',
        'For this invented evaluation: an informational request with an identified approved guide and no access or service impact is low priority and owned by Customer support. The permitted advisory next action is “Have a support agent review and share the approved onboarding guide.” The assistant does not send or share material automatically.'),
    ],
    expectedGroundingState: 'SUPPORTED', expected: labels.guidance,
    expectedSourceIdentities: ['EVAL-NORTH-GUIDANCE-INDEX-V1', 'EVAL-NORTH-GUIDANCE-ROUTING-V1'],
    reviewRationale: 'The approved guide, location, and relevant MFA topic are identified; the source defines informational priority, ownership, and the human-reviewed sharing action.' }),
  scenario({ scenarioId: 'BALANCED-GUIDANCE-402', caseType: 'guidance', tenant: 'south',
    caseFacts: 'An invented Synthetic South user asks for the location of a reimbursement policy guide. No guide identifier, location, or owner is supplied.',
    sources: [
      source('EVAL-SOUTH-GUIDANCE-INDEX-V1', 'south', 'Synthetic approved guide inventory requirements',
        'A specific guidance answer requires a matching entry in the approved Synthetic South guide inventory, including the guide title, owner, and location. The retrieved approved evidence for this scenario contains no matching reimbursement-guide entry, so it does not establish whether such a guide exists or where it is located.'),
      source('EVAL-SOUTH-GUIDANCE-BOUNDARY-V1', 'south', 'Synthetic general guidance boundary',
        'General support guidance cannot establish the location or content of a policy document without a matching approved source. Do not infer that the document does not exist, invent a location, or substitute an unrelated guide; ask a human support agent to review.'),
    ],
    expectedGroundingState: 'INSUFFICIENT_EVIDENCE', expected: null, expectedSourceIdentities: [],
    reviewRationale: 'The requested policy guide is absent from the approved inventory and has no verified owner or location; a specific answer would be invented.' }),
]);

export const groundedBalancedPlannedAttempts = 6;

export function validateGroundedBalancedDataset(scenarios: readonly GroundedBalancedScenario[] = groundedBalancedScenarios): void {
  const ids = new Set<string>();
  const sourceIds = new Set<string>();
  let supported = 0;
  let insufficient = 0;
  for (const item of scenarios) {
    const scenarioCaseType = /^BALANCED-(LOGIN|BILLING|GUIDANCE)-/.exec(item.scenarioId)?.[1]?.toLowerCase();
    if (ids.has(item.scenarioId) || !/^BALANCED-(LOGIN|BILLING|GUIDANCE)-[0-9]{3}$/.test(item.scenarioId) ||
        !['login', 'billing', 'guidance'].includes(item.caseType) || !['north', 'south'].includes(item.tenant) ||
        scenarioCaseType !== item.caseType ||
        item.caseProvenance !== groundedBalancedCaseProvenance || item.caseFacts.normalize('NFC') !== item.caseFacts ||
        Buffer.byteLength(item.caseFacts, 'utf8') < 1 || Buffer.byteLength(item.caseFacts, 'utf8') > 2048 ||
        hash(item.caseFacts) !== item.caseFactsSha256 || !item.reviewRationale || item.sources.length < 1 || item.sources.length > 5 ||
        new Set(item.expectedSourceIdentities).size !== item.expectedSourceIdentities.length) {
      throw new Error('Balanced evaluation dataset is invalid.');
    }
    ids.add(item.scenarioId);
    if (item.expectedGroundingState === 'SUPPORTED') {
      supported++;
      if (!item.expected || !item.expectedSourceIdentities.length ||
          !categories.includes(item.expected.category) || !priorities.includes(item.expected.priority) ||
          !suggestedTeams.includes(item.expected.recommendedTeam) || !recommendedActions.includes(item.expected.nextAction) ||
          !item.expectedSourceIdentities.every((identity) => item.sources.some((sourceItem) => sourceItem.sourceIdentity === identity))) {
        throw new Error('Supported balanced scenario lacks reviewed labels or source evidence.');
      }
    } else {
      insufficient++;
      if (item.expected !== null || item.expectedSourceIdentities.length > 0) throw new Error('Abstention scenario contains supported-answer labels.');
    }
    for (const sourceItem of item.sources) {
      if (sourceIds.has(sourceItem.sourceIdentity) || sourceItem.tenant !== item.tenant || sourceItem.version !== 1 ||
          sourceItem.sourceRevision !== groundedBalancedSourceRevision || sourceItem.sourceOwner !== 'Aegis synthetic evaluation corpus' ||
          !sourceItem.sourceIdentity.startsWith(`EVAL-${item.tenant.toUpperCase()}-`) ||
          !/^EVAL-(NORTH|SOUTH)-[A-Z0-9-]+-V1$/.test(sourceItem.sourceIdentity) || sourceItem.title.trim() !== sourceItem.title ||
          sourceItem.title.length < 1 || sourceItem.title.length > 160 || sourceItem.content.normalize('NFC') !== sourceItem.content ||
          Buffer.byteLength(sourceItem.content, 'utf8') < 1 || Buffer.byteLength(sourceItem.content, 'utf8') > 8192 ||
          hash(sourceItem.content) !== sourceItem.contentSha256) throw new Error('Balanced evaluation source provenance is invalid.');
      sourceIds.add(sourceItem.sourceIdentity);
    }
  }
  if (scenarios.length !== 6 || ids.size !== 6 || sourceIds.size !== 13 || supported !== 3 || insufficient !== 3) {
    throw new Error('Balanced evaluation must contain six distinct cases with three supported and three abstention labels.');
  }
}

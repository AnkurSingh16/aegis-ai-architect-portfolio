import { createHash } from 'node:crypto';
import { groundedBalancedCaseProvenance, groundedBalancedScenarios, groundedBalancedSourceRevision,
  type BalancedSourceFixture, type GroundedBalancedScenario } from './grounded-balanced-dataset.js';

/** This audit describes evidence for reviewers; it is not an authorization or model gate. */
export const groundedEvidenceAuditVersion = 'aegis-grounded-evidence-audit-v1' as const;
export const groundedEvidenceAuditReviewStatus = 'engineering_reviewed_pending_independent_review' as const;

export const evidenceAssessmentStates = [
  'EXPLICIT_SUPPORT', 'TAXONOMY_MAPPING_REQUIRED', 'MISSING_EVIDENCE', 'AMBIGUOUS', 'NOT_APPLICABLE',
] as const;
export type EvidenceAssessmentState = typeof evidenceAssessmentStates[number];

export type EvidenceField = 'category' | 'priority' | 'recommendedTeam' | 'nextAction' | 'rationale';
export type EvidenceReference =
  | { kind: 'case_facts'; scenarioId: string; contentSha256: string }
  | { kind: 'source'; sourceIdentity: string; sourceRevision: string; version: number; contentSha256: string };

export interface GroundedEvidenceFieldAssessment {
  field: EvidenceField;
  state: EvidenceAssessmentState;
  references: readonly EvidenceReference[];
  reviewNote: string;
}

export interface GroundedEvidenceScenarioAudit {
  scenarioId: string;
  evidence: readonly GroundedEvidenceFieldAssessment[];
  assessmentOnlyOutputs: readonly [
    { field: 'confidence'; state: 'NOT_APPLICABLE'; note: string },
    { field: 'uncertainty'; state: 'NOT_APPLICABLE'; note: string },
  ];
  sourceProvenance: { state: 'EXPLICIT_SUPPORT'; references: readonly EvidenceReference[] };
  tenantConsistency: { state: 'EXPLICIT_SUPPORT'; tenant: 'north' | 'south' };
  sourceRevisionConsistency: { state: 'EXPLICIT_SUPPORT'; revision: string; versions: readonly number[] };
  missingEvidence: readonly string[];
  taxonomyMappingRequirements: readonly string[];
  humanReview: { required: true; state: 'EXPLICIT_SUPPORT'; references: readonly EvidenceReference[] };
}

export interface GroundedEvidenceAudit {
  auditVersion: typeof groundedEvidenceAuditVersion;
  reviewStatus: typeof groundedEvidenceAuditReviewStatus;
  diagnosticOnly: true;
  scenarios: readonly GroundedEvidenceScenarioAudit[];
}

/** Narrow input intentionally excludes expected labels and review rationales. */
export type GroundedEvidenceAuditScenario = Pick<GroundedBalancedScenario,
  'scenarioId' | 'caseType' | 'tenant' | 'caseProvenance' | 'caseFacts' | 'caseFactsSha256' | 'sources'>;

type FieldBlueprint = Omit<GroundedEvidenceFieldAssessment, 'references'> & { sourceIdentities: readonly string[]; includeFacts?: boolean };
interface ScenarioBlueprint {
  scenarioId: string;
  fields: readonly FieldBlueprint[];
  missingEvidence: readonly string[];
  taxonomyMappingRequirements: readonly string[];
  humanReviewSourceIdentities: readonly string[];
}

/* These are source-to-field review judgments, separate from the dataset's expected answer key. */
const scenarioBlueprints: readonly ScenarioBlueprint[] = [
  {
    scenarioId: 'BALANCED-LOGIN-201',
    fields: [
      { field: 'category', state: 'TAXONOMY_MAPPING_REQUIRED', sourceIdentities: ['EVAL-NORTH-LOGIN-SEVERITY-V1'], includeFacts: true,
        reviewNote: 'The sources describe a sign-in interruption but do not name a category enum; map the domain concept to the approved taxonomy.' },
      { field: 'priority', state: 'EXPLICIT_SUPPORT', sourceIdentities: ['EVAL-NORTH-LOGIN-SEVERITY-V1', 'EVAL-NORTH-LOGIN-STATUS-V1'], includeFacts: true,
        reviewNote: 'Case facts provide the affected-account scope and duration; the source supplies the threshold and requires confirmed unavailability.' },
      { field: 'recommendedTeam', state: 'EXPLICIT_SUPPORT', sourceIdentities: ['EVAL-NORTH-LOGIN-SEVERITY-V1'],
        reviewNote: 'The source explicitly names the owning support team.' },
      { field: 'nextAction', state: 'EXPLICIT_SUPPORT', sourceIdentities: ['EVAL-NORTH-LOGIN-SEVERITY-V1'],
        reviewNote: 'The source explicitly permits an advisory impact-and-timeline review.' },
      { field: 'rationale', state: 'EXPLICIT_SUPPORT', sourceIdentities: ['EVAL-NORTH-LOGIN-SEVERITY-V1', 'EVAL-NORTH-LOGIN-STATUS-V1'], includeFacts: true,
        reviewNote: 'The case facts and status source jointly document the threshold conditions and outage observation.' },
    ],
    missingEvidence: [],
    taxonomyMappingRequirements: ['Independently map sign-in service interruption terminology to a category; source does not name the category enum.'],
    humanReviewSourceIdentities: ['EVAL-NORTH-LOGIN-SEVERITY-V1'],
  },
  {
    scenarioId: 'BALANCED-LOGIN-202',
    fields: [
      { field: 'category', state: 'TAXONOMY_MAPPING_REQUIRED', sourceIdentities: ['EVAL-SOUTH-LOGIN-SCOPE-V1'], includeFacts: true,
        reviewNote: 'The case concerns sign-in, but category still requires a reviewed mapping to the output taxonomy.' },
      { field: 'priority', state: 'MISSING_EVIDENCE', sourceIdentities: ['EVAL-SOUTH-LOGIN-SCOPE-V1', 'EVAL-SOUTH-LOGIN-STATUS-V1'], includeFacts: true,
        reviewNote: 'The case lacks affected-account scope, duration, and a recorded status observation required before severity is assigned.' },
      { field: 'recommendedTeam', state: 'MISSING_EVIDENCE', sourceIdentities: ['EVAL-SOUTH-LOGIN-SCOPE-V1'],
        reviewNote: 'The source says ownership must not be assigned until required impact evidence is established.' },
      { field: 'nextAction', state: 'MISSING_EVIDENCE', sourceIdentities: ['EVAL-SOUTH-LOGIN-SCOPE-V1', 'EVAL-SOUTH-LOGIN-STATUS-V1'],
        reviewNote: 'The source requires scope, duration, and a status observation before selecting an investigation step.' },
      { field: 'rationale', state: 'EXPLICIT_SUPPORT', sourceIdentities: ['EVAL-SOUTH-LOGIN-SCOPE-V1', 'EVAL-SOUTH-LOGIN-STATUS-V1'], includeFacts: true,
        reviewNote: 'The missing scope, duration, and status observation are explicitly described by the facts and source requirements.' },
    ],
    missingEvidence: ['Affected-account count', 'Duration of the sign-in failure', 'Approved status observation for the relevant time window'],
    taxonomyMappingRequirements: ['Map sign-in report terminology to the category taxonomy; this mapping does not establish outage severity.'],
    humanReviewSourceIdentities: ['EVAL-SOUTH-LOGIN-SCOPE-V1', 'EVAL-SOUTH-LOGIN-STATUS-V1'],
  },
  {
    scenarioId: 'BALANCED-BILLING-301',
    fields: [
      { field: 'category', state: 'TAXONOMY_MAPPING_REQUIRED', sourceIdentities: ['EVAL-SOUTH-BILLING-REVIEW-V1', 'EVAL-SOUTH-BILLING-LEDGER-V1'], includeFacts: true,
        reviewNote: 'The sources establish a duplicate invoice entry; mapping that billing-domain issue to a category enum remains a taxonomy decision.' },
      { field: 'priority', state: 'EXPLICIT_SUPPORT', sourceIdentities: ['EVAL-SOUTH-BILLING-REVIEW-V1', 'EVAL-SOUTH-BILLING-LEDGER-V1', 'EVAL-SOUTH-BILLING-STATUS-V1'], includeFacts: true,
        reviewNote: 'The ledger confirms the duplicate service line and the service check reports no disruption; the criteria specify the priority.' },
      { field: 'recommendedTeam', state: 'EXPLICIT_SUPPORT', sourceIdentities: ['EVAL-SOUTH-BILLING-REVIEW-V1'],
        reviewNote: 'The criteria explicitly name the owning billing team.' },
      { field: 'nextAction', state: 'EXPLICIT_SUPPORT', sourceIdentities: ['EVAL-SOUTH-BILLING-REVIEW-V1'],
        reviewNote: 'The criteria provide a comparison-only advisory action and prohibit balance changes or refund promises.' },
      { field: 'rationale', state: 'EXPLICIT_SUPPORT', sourceIdentities: ['EVAL-SOUTH-BILLING-REVIEW-V1', 'EVAL-SOUTH-BILLING-LEDGER-V1', 'EVAL-SOUTH-BILLING-STATUS-V1'], includeFacts: true,
        reviewNote: 'The case facts and ledger/status sources identify the invoice match, amount, period, and absence of service disruption.' },
    ],
    missingEvidence: [],
    taxonomyMappingRequirements: ['Independently map the duplicate-invoice concept to the category taxonomy; the source does not state the enum label.'],
    humanReviewSourceIdentities: ['EVAL-SOUTH-BILLING-REVIEW-V1'],
  },
  {
    scenarioId: 'BALANCED-BILLING-302',
    fields: [
      { field: 'category', state: 'TAXONOMY_MAPPING_REQUIRED', sourceIdentities: ['EVAL-NORTH-BILLING-REQUIREMENTS-V1'], includeFacts: true,
        reviewNote: 'The report concerns billing, but mapping the domain to an output category still requires taxonomy review.' },
      { field: 'priority', state: 'MISSING_EVIDENCE', sourceIdentities: ['EVAL-NORTH-BILLING-REQUIREMENTS-V1', 'EVAL-NORTH-BILLING-LEDGER-V1'], includeFacts: true,
        reviewNote: 'The invoice identifiers, period, line-item totals, and ledger result required for a discrepancy assessment are absent.' },
      { field: 'recommendedTeam', state: 'MISSING_EVIDENCE', sourceIdentities: ['EVAL-NORTH-BILLING-REQUIREMENTS-V1'],
        reviewNote: 'The source says discrepancy and responsible team cannot be established without the missing comparison evidence.' },
      { field: 'nextAction', state: 'MISSING_EVIDENCE', sourceIdentities: ['EVAL-NORTH-BILLING-REQUIREMENTS-V1', 'EVAL-NORTH-BILLING-LEDGER-V1'], includeFacts: true,
        reviewNote: 'No invoice identifiers, period, totals, or ledger result is available to ground a specific comparison step.' },
      { field: 'rationale', state: 'EXPLICIT_SUPPORT', sourceIdentities: ['EVAL-NORTH-BILLING-REQUIREMENTS-V1', 'EVAL-NORTH-BILLING-LEDGER-V1'], includeFacts: true,
        reviewNote: 'The facts and sources explicitly expose which comparison inputs and ledger result are missing.' },
    ],
    missingEvidence: ['Invoice identifiers', 'Billing period', 'Line-item totals', 'Approved ledger lookup result'],
    taxonomyMappingRequirements: ['Map billing-report terminology to the category taxonomy; this does not establish a billing discrepancy.'],
    humanReviewSourceIdentities: ['EVAL-NORTH-BILLING-REQUIREMENTS-V1'],
  },
  {
    scenarioId: 'BALANCED-GUIDANCE-401',
    fields: [
      { field: 'category', state: 'TAXONOMY_MAPPING_REQUIRED', sourceIdentities: ['EVAL-NORTH-GUIDANCE-INDEX-V1', 'EVAL-NORTH-GUIDANCE-ROUTING-V1'], includeFacts: true,
        reviewNote: 'The request and approved guide are informational; mapping them to the output category enum remains a taxonomy decision.' },
      { field: 'priority', state: 'EXPLICIT_SUPPORT', sourceIdentities: ['EVAL-NORTH-GUIDANCE-ROUTING-V1'], includeFacts: true,
        reviewNote: 'The case facts establish no access or service impact and the criteria specify the priority for an informational request.' },
      { field: 'recommendedTeam', state: 'EXPLICIT_SUPPORT', sourceIdentities: ['EVAL-NORTH-GUIDANCE-ROUTING-V1'],
        reviewNote: 'The routing criteria explicitly name the support team.' },
      { field: 'nextAction', state: 'EXPLICIT_SUPPORT', sourceIdentities: ['EVAL-NORTH-GUIDANCE-INDEX-V1', 'EVAL-NORTH-GUIDANCE-ROUTING-V1'], includeFacts: true,
        reviewNote: 'The approved guide is identified and the criteria permit a human-reviewed sharing action.' },
      { field: 'rationale', state: 'EXPLICIT_SUPPORT', sourceIdentities: ['EVAL-NORTH-GUIDANCE-INDEX-V1', 'EVAL-NORTH-GUIDANCE-ROUTING-V1'], includeFacts: true,
        reviewNote: 'The requested topic, approved guide location, and low-impact routing criteria are present.' },
    ],
    missingEvidence: [],
    taxonomyMappingRequirements: ['Independently map the informational guide request to the category taxonomy; the sources do not name the enum.'],
    humanReviewSourceIdentities: ['EVAL-NORTH-GUIDANCE-ROUTING-V1'],
  },
  {
    scenarioId: 'BALANCED-GUIDANCE-402',
    fields: [
      { field: 'category', state: 'TAXONOMY_MAPPING_REQUIRED', sourceIdentities: ['EVAL-SOUTH-GUIDANCE-INDEX-V1', 'EVAL-SOUTH-GUIDANCE-BOUNDARY-V1'], includeFacts: true,
        reviewNote: 'The request concerns a guide, but matching it to an output category remains a taxonomy mapping.' },
      { field: 'priority', state: 'MISSING_EVIDENCE', sourceIdentities: ['EVAL-SOUTH-GUIDANCE-INDEX-V1', 'EVAL-SOUTH-GUIDANCE-BOUNDARY-V1'],
        reviewNote: 'No matching approved guide or impact criteria determine a complete priority assessment.' },
      { field: 'recommendedTeam', state: 'MISSING_EVIDENCE', sourceIdentities: ['EVAL-SOUTH-GUIDANCE-INDEX-V1', 'EVAL-SOUTH-GUIDANCE-BOUNDARY-V1'],
        reviewNote: 'The matching guide owner is absent, so a specific responsible team is not established.' },
      { field: 'nextAction', state: 'MISSING_EVIDENCE', sourceIdentities: ['EVAL-SOUTH-GUIDANCE-INDEX-V1', 'EVAL-SOUTH-GUIDANCE-BOUNDARY-V1'], includeFacts: true,
        reviewNote: 'The guide title, verified location, and owner required for a specific sharing action are unavailable.' },
      { field: 'rationale', state: 'EXPLICIT_SUPPORT', sourceIdentities: ['EVAL-SOUTH-GUIDANCE-INDEX-V1', 'EVAL-SOUTH-GUIDANCE-BOUNDARY-V1'], includeFacts: true,
        reviewNote: 'The sources explicitly state that the requested matching guide entry is absent and prohibit inventing a location.' },
    ],
    missingEvidence: ['Matching approved reimbursement guide entry', 'Guide owner', 'Verified guide location'],
    taxonomyMappingRequirements: ['Map a guide-location request to the category taxonomy without inferring that the requested guide exists.'],
    humanReviewSourceIdentities: ['EVAL-SOUTH-GUIDANCE-BOUNDARY-V1'],
  },
];

const expectedScenarioIds = scenarioBlueprints.map((item) => item.scenarioId);

export class GroundedEvidenceAuditError extends Error {
  constructor(readonly reason: 'invalid_scenario_set' | 'invalid_case_provenance' | 'case_facts_hash_mismatch' |
    'duplicate_source_identity' | 'source_tenant_mismatch' | 'source_identity_mismatch' | 'source_version_mismatch' |
    'source_revision_mismatch' | 'source_owner_mismatch' | 'source_hash_mismatch' | 'missing_evidence_reference' |
    'empty_evidence_reference' | 'invalid_case_facts' | 'invalid_source_shape' | 'unreviewed_fixture_change') {
    super('Grounded evidence audit input failed deterministic validation.');
  }
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function caseFactsReference(scenario: GroundedEvidenceAuditScenario): EvidenceReference {
  return { kind: 'case_facts', scenarioId: scenario.scenarioId, contentSha256: scenario.caseFactsSha256 };
}

function sourceReference(source: BalancedSourceFixture): EvidenceReference {
  return { kind: 'source', sourceIdentity: source.sourceIdentity, sourceRevision: source.sourceRevision,
    version: source.version, contentSha256: source.contentSha256 };
}

function assertMatchesCanonicalFixture(scenario: GroundedEvidenceAuditScenario, canonical: GroundedBalancedScenario): void {
  if (scenario.scenarioId !== canonical.scenarioId || scenario.caseType !== canonical.caseType || scenario.tenant !== canonical.tenant ||
      scenario.caseProvenance !== canonical.caseProvenance || scenario.caseFacts !== canonical.caseFacts ||
      scenario.caseFactsSha256 !== canonical.caseFactsSha256 || scenario.sources.length !== canonical.sources.length) {
    throw new GroundedEvidenceAuditError('unreviewed_fixture_change');
  }
  for (let index = 0; index < canonical.sources.length; index += 1) {
    const source = scenario.sources[index];
    const approved = canonical.sources[index];
    if (!source || !approved || source.sourceIdentity !== approved.sourceIdentity || source.tenant !== approved.tenant ||
        source.title !== approved.title || source.version !== approved.version || source.sourceRevision !== approved.sourceRevision ||
        source.sourceOwner !== approved.sourceOwner || source.content !== approved.content || source.contentSha256 !== approved.contentSha256) {
      throw new GroundedEvidenceAuditError('unreviewed_fixture_change');
    }
  }
}

function validateInput(scenarios: readonly GroundedEvidenceAuditScenario[]): void {
  if (!Array.isArray(scenarios) || scenarios.length !== expectedScenarioIds.length ||
      scenarios.some((item) => !item || typeof item !== 'object') ||
      scenarios.map((item) => item.scenarioId).join('\0') !== expectedScenarioIds.join('\0')) {
    throw new GroundedEvidenceAuditError('invalid_scenario_set');
  }
  const allIdentities = new Set<string>();
  for (let scenarioIndex = 0; scenarioIndex < scenarios.length; scenarioIndex += 1) {
    const scenario = scenarios[scenarioIndex]!;
    if (scenario.tenant !== 'north' && scenario.tenant !== 'south') throw new GroundedEvidenceAuditError('invalid_scenario_set');
    if (scenario.caseProvenance !== groundedBalancedCaseProvenance) throw new GroundedEvidenceAuditError('invalid_case_provenance');
    const idCaseType = /^BALANCED-(LOGIN|BILLING|GUIDANCE)-[0-9]{3}$/.exec(scenario.scenarioId)?.[1]?.toLowerCase();
    if (idCaseType !== scenario.caseType) throw new GroundedEvidenceAuditError('invalid_scenario_set');
    if (typeof scenario.caseFacts !== 'string' || scenario.caseFacts.normalize('NFC') !== scenario.caseFacts ||
        Buffer.byteLength(scenario.caseFacts, 'utf8') < 1 || Buffer.byteLength(scenario.caseFacts, 'utf8') > 2048) {
      throw new GroundedEvidenceAuditError('invalid_case_facts');
    }
    if (sha256(scenario.caseFacts) !== scenario.caseFactsSha256) throw new GroundedEvidenceAuditError('case_facts_hash_mismatch');
    if (!Array.isArray(scenario.sources) || scenario.sources.length < 1 || scenario.sources.length > 5) {
      throw new GroundedEvidenceAuditError('invalid_source_shape');
    }
    for (const source of scenario.sources) {
      if (!source || typeof source !== 'object') throw new GroundedEvidenceAuditError('invalid_source_shape');
      if (allIdentities.has(source.sourceIdentity)) throw new GroundedEvidenceAuditError('duplicate_source_identity');
      allIdentities.add(source.sourceIdentity);
      if (source.tenant !== scenario.tenant) throw new GroundedEvidenceAuditError('source_tenant_mismatch');
      if (!source.sourceIdentity.startsWith(`EVAL-${scenario.tenant.toUpperCase()}-`)) {
        throw new GroundedEvidenceAuditError('source_identity_mismatch');
      }
      if (!/^EVAL-(NORTH|SOUTH)-[A-Z0-9-]+-V1$/.test(source.sourceIdentity) || source.title.trim() !== source.title ||
          source.title.length < 1 || source.title.length > 160 || source.content.normalize('NFC') !== source.content ||
          Buffer.byteLength(source.content, 'utf8') < 1 || Buffer.byteLength(source.content, 'utf8') > 8192) {
        throw new GroundedEvidenceAuditError('invalid_source_shape');
      }
      if (source.version !== 1) throw new GroundedEvidenceAuditError('source_version_mismatch');
      if (source.sourceRevision !== groundedBalancedSourceRevision) throw new GroundedEvidenceAuditError('source_revision_mismatch');
      if (source.sourceOwner !== 'Aegis synthetic evaluation corpus') throw new GroundedEvidenceAuditError('source_owner_mismatch');
      if (sha256(source.content) !== source.contentSha256) throw new GroundedEvidenceAuditError('source_hash_mismatch');
    }
    const canonical = groundedBalancedScenarios[scenarioIndex];
    if (!canonical) throw new GroundedEvidenceAuditError('invalid_scenario_set');
    assertMatchesCanonicalFixture(scenario, canonical);
  }
}

function buildReferences(scenario: GroundedEvidenceAuditScenario, identities: readonly string[], includeFacts = false): EvidenceReference[] {
  const found = new Map(scenario.sources.map((source) => [source.sourceIdentity, source]));
  const references = identities.map((identity) => {
    const source = found.get(identity);
    if (!source) throw new GroundedEvidenceAuditError('missing_evidence_reference');
    return sourceReference(source);
  });
  if (includeFacts) references.unshift(caseFactsReference(scenario));
  if (references.length === 0) throw new GroundedEvidenceAuditError('empty_evidence_reference');
  return references;
}

/** Returns a bounded, read-only evidence assessment; it never reads answer labels or review rationales. */
export function auditGroundedEvidence(
  scenarios: readonly GroundedEvidenceAuditScenario[] = groundedBalancedScenarios,
): GroundedEvidenceAudit {
  validateInput(scenarios);
  const byId = new Map(scenarios.map((scenario) => [scenario.scenarioId, scenario]));
  const audited = scenarioBlueprints.map((blueprint): GroundedEvidenceScenarioAudit => {
    const scenario = byId.get(blueprint.scenarioId);
    if (!scenario) throw new GroundedEvidenceAuditError('invalid_scenario_set');
    const sources = scenario.sources;
    const allSourceReferences = sources.map(sourceReference);
    return {
      scenarioId: scenario.scenarioId,
      evidence: blueprint.fields.map((field) => ({ field: field.field, state: field.state,
        references: buildReferences(scenario, field.sourceIdentities, field.includeFacts), reviewNote: field.reviewNote })),
      assessmentOnlyOutputs: [
        { field: 'confidence', state: 'NOT_APPLICABLE', note: 'Confidence is an assessment output; this audit assigns no value.' },
        { field: 'uncertainty', state: 'NOT_APPLICABLE', note: 'Uncertainty is an assessment output; this audit assigns no value.' },
      ],
      sourceProvenance: { state: 'EXPLICIT_SUPPORT', references: allSourceReferences },
      tenantConsistency: { state: 'EXPLICIT_SUPPORT', tenant: scenario.tenant },
      sourceRevisionConsistency: { state: 'EXPLICIT_SUPPORT', revision: groundedBalancedSourceRevision,
        versions: [...new Set(sources.map((source) => source.version))].sort() },
      missingEvidence: [...blueprint.missingEvidence],
      taxonomyMappingRequirements: [...blueprint.taxonomyMappingRequirements],
      humanReview: { required: true, state: 'EXPLICIT_SUPPORT',
        references: buildReferences(scenario, blueprint.humanReviewSourceIdentities) },
    };
  });
  return { auditVersion: groundedEvidenceAuditVersion, reviewStatus: groundedEvidenceAuditReviewStatus,
    diagnosticOnly: true, scenarios: audited };
}

/** Exposed for deterministic fixture-integrity tests; contains no expected labels. */
export function groundedEvidenceFixtureFingerprint(scenarios: readonly GroundedEvidenceAuditScenario[] = groundedBalancedScenarios) {
  return scenarios.map((scenario) => ({ scenarioId: scenario.scenarioId, caseFactsSha256: scenario.caseFactsSha256,
    sources: scenario.sources.map((source) => ({ sourceIdentity: source.sourceIdentity, version: source.version,
      sourceRevision: source.sourceRevision, contentSha256: source.contentSha256 })) }));
}

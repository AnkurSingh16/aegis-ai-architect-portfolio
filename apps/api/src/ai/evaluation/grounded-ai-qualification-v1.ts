import { createHash } from 'node:crypto';
import { groundedBalancedDatasetVersion, groundedBalancedLabelStatus, groundedBalancedScenarios } from './grounded-balanced-dataset.js';
import { scoreGroundedBalancedEvaluation, type BalancedObservation } from './grounded-balanced-scoring.js';

export const groundedAiQualificationV1ReportRelativePath =
  '.local/evaluations/grounded-ai-qualification-qwen2.5-3b-instruct-v1.json';

export const groundedAiQualificationV1Contract = Object.freeze({
  evaluatorVersion: 'aegis-grounded-ai-qualification-v1',
  reportSchemaVersion: 'aegis-grounded-ai-qualification-report-v1',
  baselineCommit: 'b383413d7874665b9056f80753d12b000f5fe5b9',
  m422ReleaseCommit: '3fe57fd8a366b4532a440222355de0a5b3821c1d',
  m423ReleaseCommit: '59cb95f32389ae1ed2fd6715f1e0e983bffb6b0c',
  sourceIdentityReleaseCommit: 'f242ffb25c02a1f630caa06ff24c945a5b663c7f',
  sourceIdentityReviewedHead: 'bb94ed7ae47da6bf5119674beaf82ea0f6ddc59b',
  sourceIdentityReviewedRunnerSha256: 'f616753a6e0e5f4d685e422efd79df9ff7244341d2fc3dbef2598f9af7e42d80',
  model: 'qwen2.5:3b-instruct',
  modelManifestDigest: 'sha256:357c53fb659c5076de1d65ccb0b397446227b71a42be9d1603d46168015c9e4b',
  ollamaVersion: '0.40.15',
  endpoint: 'http://127.0.0.1:11434/api/generate',
  datasetVersion: groundedBalancedDatasetVersion,
  labelProvenance: groundedBalancedLabelStatus,
  scenarios: 6,
  expectedSupported: 3,
  expectedInsufficientEvidence: 3,
  distinctSources: 13,
  maximumRequests: 6,
  maximumAttemptsPerScenario: 1,
  maximumConcurrency: 1,
  retryCount: 0,
  timeoutMs: 15000,
  temperature: 0.1,
  numPredict: 256,
  naturalTwoBranchSchema: true,
  smokePassThresholds: Object.freeze({
    completedScenarios: 6,
    validJson: 6,
    schemaAndParserAccepted: 6,
    humanReviewRequired: 6,
    expectedSupportedCoverage: 3,
    correctInsufficientEvidenceAbstentions: 3,
    falseSupportedAnswers: 0,
    supportedCitationIdentityValidity: 3,
    expectedSourceCoverage: 1,
    categoryAgreement: 1,
    priorityAgreement: 1,
    recommendedTeamAgreement: 1,
    nextActionAgreement: 1,
    confidenceValidForAcceptedOutputs: true,
    independentDatasetReviewers: 2,
    independentSemanticReviewers: 2,
    semanticEntailmentFailures: 0,
    decisionQualityStatus: 'NOT_QUALIFIED',
  }),
});

/** SHA-256 of raw source-file bytes from the approved baseline commit. */
export const groundedAiQualificationV1ProtectedFileSha256 = Object.freeze({
  'apps/api/src/ai/evaluation/grounded-balanced-dataset.ts': 'f8e1d01cf29bab57063a60b56e3b4ffea35f9e9c05d3a5097c7fdcbaaf1e1e4f',
  'apps/api/src/ai/evaluation/grounded-balanced-scoring.ts': 'dd9e6fa6345493b78d2cf895d2190f87b47c97438bb71ed450686428c0485ac2',
  'apps/api/src/ai/evaluation/grounded-balanced-runner.ts': '0e5d77dd8512f81bb473b93dc5f3d2752ea8eb3c15e4900d42f1f300d900fe18',
  'apps/api/src/ai/evaluation/grounded-balanced-report-v2.ts': '67e56925684e2fae5ffa595a6373ab763bd3762543e03f9e38825f47226b7edc',
  'apps/api/src/ai/evaluation/grounded-provider-diagnostics.ts': '0e544bb1b7e18d318a71bcbb41fc5ccbe0bbfa6078415a36a5f96c3f8451e344',
  'apps/api/src/ai/evaluation/grounded-output-budget.ts': 'a6317957ff2d29e949c34762ca868cb5a2eef8c927c7e794902d3a0754a215dc',
  'apps/api/src/ai/evaluation/private-report.ts': '22991acc8cc6189d077953d5f39b7a42e567ffbf5d8049f16e7b1c1c4181c555',
  'apps/api/src/ai/evaluation/ollama-socket-preflight.ts': 'a1a42208f5bb43ad5769145f3393dfafb65e224ada197548e63806f8d6e4cc4b',
  'apps/api/src/ai/evaluation/source-identity.ts': 'c3559e8eab3923782fd453ce085d47d0f6dee0d45c6ebda19aa0110d5de62019',
  'apps/api/src/ai/grounded-provider.ts': '37b14e3cc0e5092128f482e368fdd6b0f450e4985a2899bb9af9b7fe37ec4a92',
  'apps/api/src/ai/grounded-analysis.ts': 'fafa327c4c4fe04ecb8507fa522b9e80c135c62169ed51a26dc01025c859d751',
  'apps/api/src/ai/provider.ts': 'ba9231a70ff4d1aea4937b9f105faaf9e6669b17237826d0c588b4e1e822c835',
  'apps/api/src/documents/retrieval.ts': 'd4bdcb2fb9e22da53e8ec9ac10c3c6d5d55d340f7000647f6adf117456df54fa',
  'apps/api/src/ai/evaluation/grounded-supported-output-diagnostic.ts': '0bbf5441aff42bf0b50fb7ad260f3dc1dea89a64f7c11413863e5e1aaf072ea2',
  'apps/api/src/ai/evaluation/run-grounded-supported-output-diagnostic-local.ts': 'f616753a6e0e5f4d685e422efd79df9ff7244341d2fc3dbef2598f9af7e42d80',
});

/** Pinned after the runner source is finalized; the verifier itself is anchored by independently verified release CI. */
export const groundedAiQualificationV1ReviewedFileSha256 = Object.freeze({
  'apps/api/src/ai/evaluation/run-grounded-ai-qualification-v1-local.ts': '872358e92f38b04566c2c43978a6180614144e9ed749a0820ab138912a11aabe',
});

export type QualificationGitRead = (args: readonly string[]) => string;
export type QualificationBlobSha256 = (ref: string, path: string) => string;

export interface QualificationV1SourceIdentity {
  baselineCommit: string;
  m422ReleaseCommit: string;
  m423ReleaseCommit: string;
  sourceIdentityReleaseCommit: string;
  sourceIdentityReviewedHead: string;
  codeCommit: string;
  treeHash: string;
  protectedFileSha256: Readonly<Record<string, string>>;
}

function sourceError(code: string): never {
  throw new Error(`qualification_source_${code}`);
}

function requireCommit(readGit: QualificationGitRead, ref: string, expected: string): void {
  let actual: string;
  try { actual = readGit(['rev-parse', `${ref}^{commit}`]).trim(); }
  catch { sourceError('approved_ref_missing'); }
  if (actual !== expected) sourceError('approved_ref_mismatch');
}

function requireAncestry(readGit: QualificationGitRead, ancestor: string, descendant: string): void {
  try { readGit(['merge-base', '--is-ancestor', ancestor, descendant]); }
  catch { sourceError('approved_release_not_ancestor'); }
}

/**
 * Release identity is supplied from the separately reviewed exact-head CI/merge record.
 * This local verifier checks that identity against clean main and immutable source
 * anchors; its hashes are not a substitute for independent PR review or CI evidence.
 */
export function verifyGroundedAiQualificationV1Source(
  readGit: QualificationGitRead,
  readBlobSha256: QualificationBlobSha256,
  approvedReleaseSha: string,
): QualificationV1SourceIdentity {
  if (!/^[0-9a-f]{40}$/.test(approvedReleaseSha)) sourceError('release_sha_required');
  try {
    if (readGit(['branch', '--show-current']).trim() !== 'main') sourceError('main_required');
    if (readGit(['status', '--porcelain=v1']).trim() !== '') sourceError('dirty_checkout');
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('qualification_source_')) throw error;
    sourceError('git_preflight_failed');
  }

  let codeCommit: string;
  let treeHash: string;
  let remoteCommit: string;
  let remoteTree: string;
  let liveRemote: string;
  try {
    codeCommit = readGit(['rev-parse', 'HEAD']).trim();
    treeHash = readGit(['rev-parse', 'HEAD^{tree}']).trim();
    remoteCommit = readGit(['rev-parse', 'origin/main']).trim();
    remoteTree = readGit(['rev-parse', 'origin/main^{tree}']).trim();
    liveRemote = readGit(['ls-remote', 'origin', 'refs/heads/main']).trim();
  } catch { sourceError('main_ref_missing'); }
  if (codeCommit !== approvedReleaseSha || remoteCommit !== approvedReleaseSha || treeHash !== remoteTree ||
      liveRemote !== `${approvedReleaseSha}\trefs/heads/main`) {
    sourceError('unsupported_or_unsynchronized_release');
  }

  const immutableCommits = [
    groundedAiQualificationV1Contract.baselineCommit,
    groundedAiQualificationV1Contract.m422ReleaseCommit,
    groundedAiQualificationV1Contract.m423ReleaseCommit,
    groundedAiQualificationV1Contract.sourceIdentityReleaseCommit,
    groundedAiQualificationV1Contract.sourceIdentityReviewedHead,
  ];
  for (const commit of immutableCommits) requireCommit(readGit, commit, commit);
  requireAncestry(readGit, groundedAiQualificationV1Contract.baselineCommit, codeCommit);
  requireAncestry(readGit, groundedAiQualificationV1Contract.m422ReleaseCommit, codeCommit);
  requireAncestry(readGit, groundedAiQualificationV1Contract.m423ReleaseCommit, codeCommit);
  requireAncestry(readGit, groundedAiQualificationV1Contract.sourceIdentityReleaseCommit, codeCommit);
  requireAncestry(readGit, groundedAiQualificationV1Contract.sourceIdentityReleaseCommit,
    groundedAiQualificationV1Contract.sourceIdentityReviewedHead);

  const reviewedRunner = 'apps/api/src/ai/evaluation/run-grounded-supported-output-diagnostic-local.ts';
  if (readBlobSha256(groundedAiQualificationV1Contract.sourceIdentityReviewedHead, reviewedRunner) !==
      groundedAiQualificationV1Contract.sourceIdentityReviewedRunnerSha256) sourceError('reviewed_gate_anchor_mismatch');

  const protectedFileSha256: Record<string, string> = {};
  for (const [path, expectedSha256] of Object.entries(groundedAiQualificationV1ProtectedFileSha256)) {
    let baselineHash: string;
    let releaseHash: string;
    try {
      baselineHash = readBlobSha256(groundedAiQualificationV1Contract.baselineCommit, path);
      releaseHash = readBlobSha256(codeCommit, path);
    } catch { sourceError('protected_file_missing'); }
    if (baselineHash !== expectedSha256 || releaseHash !== expectedSha256) sourceError('protected_file_hash_mismatch');
    protectedFileSha256[path] = releaseHash;
  }
  for (const [path, expectedSha256] of Object.entries(groundedAiQualificationV1ReviewedFileSha256)) {
    if (!/^[0-9a-f]{64}$/.test(expectedSha256)) sourceError('reviewed_source_anchor_unset');
    let releaseHash: string;
    try { releaseHash = readBlobSha256(codeCommit, path); }
    catch { sourceError('reviewed_source_missing'); }
    if (releaseHash !== expectedSha256) sourceError('reviewed_source_hash_mismatch');
    protectedFileSha256[path] = releaseHash;
  }
  return {
    baselineCommit: groundedAiQualificationV1Contract.baselineCommit,
    m422ReleaseCommit: groundedAiQualificationV1Contract.m422ReleaseCommit,
    m423ReleaseCommit: groundedAiQualificationV1Contract.m423ReleaseCommit,
    sourceIdentityReleaseCommit: groundedAiQualificationV1Contract.sourceIdentityReleaseCommit,
    sourceIdentityReviewedHead: groundedAiQualificationV1Contract.sourceIdentityReviewedHead,
    codeCommit,
    treeHash,
    protectedFileSha256,
  };
}

export interface QualificationV1ReviewEvidence {
  datasetReview: {
    datasetSha256: string;
    attestationCount: number;
    manifestClaimsApproval: boolean;
    independentlyVerified: boolean;
  };
  semanticReview: {
    independentReviewerCount: number;
    complete: boolean;
    entailmentFailures: number;
  };
}

export type QualificationV1Decision = 'PASS_SMOKE' | 'FAIL' | 'INCONCLUSIVE';

export interface QualificationV1CaseResult {
  scenarioId: string;
  requestStatus: 'completed' | 'failed' | 'not_attempted';
  jsonParseAccepted: boolean | null;
  schemaAccepted: boolean | null;
  parserAccepted: boolean | null;
  groundingState: 'SUPPORTED' | 'INSUFFICIENT_EVIDENCE' | null;
  citationIdentityValid: boolean | null;
  expectedSourceCoverage: boolean | null;
  classificationFieldAgreement: {
    category: boolean | null;
    priority: boolean | null;
    recommendedTeam: boolean | null;
    nextAction: boolean | null;
  };
  confidenceValidation: 'valid' | 'invalid' | 'not_reached';
  humanReviewRequired: boolean | null;
  failureStage: string | null;
  validationReason: string | null;
  latencyMs: number | null;
  promptTokens: number | null;
  generatedTokens: number | null;
}

export interface QualificationV1Evaluation {
  decision: QualificationV1Decision;
  decisionQualityStatus: 'NOT_QUALIFIED';
  requestCount: number;
  completedCount: number;
  failedCount: number;
  notAttemptedCount: number;
  criteria: Readonly<Record<string, boolean | null>>;
  metrics: ReturnType<typeof scoreGroundedBalancedEvaluation>;
  outcomes: readonly QualificationV1CaseResult[];
}

function caseResult(observation: BalancedObservation): QualificationV1CaseResult {
  const expected = observation.expected;
  const accepted = observation.status === 'success' && observation.schemaAccepted === true && observation.parsedJson === true;
  const supported = accepted && observation.groundingState === 'SUPPORTED';
  const classification = (field: 'category' | 'priority' | 'recommendedTeam' | 'nextAction'): boolean | null => {
    if (!supported) return null;
    return expected === null ? false : observation[field] === expected[field];
  };
  return {
    scenarioId: observation.scenarioId,
    requestStatus: observation.status === 'success' ? 'completed' : observation.status === 'failure' ? 'failed' : 'not_attempted',
    jsonParseAccepted: observation.parsedJson,
    schemaAccepted: observation.schemaAccepted,
    parserAccepted: observation.status === 'success' ? true : observation.status === 'failure' && observation.failureStage === 'output_schema' ? false : null,
    groundingState: observation.groundingState,
    citationIdentityValid: observation.citationsValid === false ? false : supported ? observation.citationsValid : null,
    expectedSourceCoverage: observation.citationsValid === false ? false : supported ? observation.expectedSourceIdentities.length > 0 &&
      observation.expectedSourceIdentities.every((identity) => observation.citedExpectedSourceIdentities.includes(identity)) : null,
    classificationFieldAgreement: {
      category: classification('category'),
      priority: classification('priority'),
      recommendedTeam: classification('recommendedTeam'),
      nextAction: classification('nextAction'),
    },
    confidenceValidation: accepted ? 'valid' : observation.validationReason === 'invalid_confidence' ? 'invalid' : 'not_reached',
    humanReviewRequired: observation.humanReviewRequired,
    failureStage: observation.failureStage,
    validationReason: observation.validationReason,
    latencyMs: observation.latencyMs,
    promptTokens: observation.promptTokens,
    generatedTokens: observation.generatedTokens,
  };
}

/** Hashes the exact facts, synthetic evidence, expected state, labels, source IDs and rationale. */
export function groundedAiQualificationV1DatasetSha256(): string {
  const frozenDataset = groundedBalancedScenarios.map((scenario) => ({
    scenarioId: scenario.scenarioId,
    caseType: scenario.caseType,
    tenant: scenario.tenant,
    caseProvenance: scenario.caseProvenance,
    caseFacts: scenario.caseFacts,
    caseFactsSha256: scenario.caseFactsSha256,
    sources: scenario.sources,
    expectedGroundingState: scenario.expectedGroundingState,
    expected: scenario.expected,
    expectedSourceIdentities: scenario.expectedSourceIdentities,
    reviewRationale: scenario.reviewRationale,
  }));
  return createHash('sha256').update(canonicalJson(frozenDataset), 'utf8').digest('hex');
}

/** Evaluate already-sanitized, provider-free observations; never calls Ollama or writes reports. */
export function evaluateGroundedAiQualificationV1(
  observations: readonly BalancedObservation[],
  review: QualificationV1ReviewEvidence,
): QualificationV1Evaluation {
  const expectedIds = groundedBalancedScenarios.map((scenario) => scenario.scenarioId);
  const ordered = expectedIds.map((id) => observations.find((item) => item.scenarioId === id));
  const shapeValid = observations.length === groundedAiQualificationV1Contract.scenarios &&
    new Set(observations.map((item) => item.scenarioId)).size === groundedAiQualificationV1Contract.scenarios &&
    ordered.every((item): item is BalancedObservation => item !== undefined);
  const items = shapeValid ? ordered as BalancedObservation[] : [...observations];
  const metrics = scoreGroundedBalancedEvaluation(items);
  const outcomes = items.map(caseResult);
  const completed = items.filter((item) => item.status === 'success');
  const failed = items.filter((item) => item.status === 'failure');
  const notAttempted = items.filter((item) => item.status === 'not_attempted');
  const supportedExpected = items.filter((item) => item.expectedGroundingState === 'SUPPORTED');
  const insufficientExpected = items.filter((item) => item.expectedGroundingState === 'INSUFFICIENT_EVIDENCE');
  const supported = supportedExpected.filter((item) => item.status === 'success' && item.groundingState === 'SUPPORTED');
  const abstained = insufficientExpected.filter((item) => item.status === 'success' && item.groundingState === 'INSUFFICIENT_EVIDENCE');
  const falseSupported = insufficientExpected.filter((item) => item.status === 'success' && item.groundingState === 'SUPPORTED');
  const exactSupportedLabels = supported.length === groundedAiQualificationV1Contract.expectedSupported && supported.every((item) =>
    item.expected !== null && item.category === item.expected.category && item.priority === item.expected.priority &&
    item.recommendedTeam === item.expected.recommendedTeam && item.nextAction === item.expected.nextAction);
  const citationGate = supported.length === groundedAiQualificationV1Contract.expectedSupported && supported.every((item) =>
    item.citationsValid === true && item.expectedSourceIdentities.length > 0 &&
    item.expectedSourceIdentities.every((identity) => item.citedExpectedSourceIdentities.includes(identity)));
  const schemaParserGate = items.length === groundedAiQualificationV1Contract.scenarios && items.every((item) =>
    item.status === 'success' && item.parsedJson === true && item.schemaAccepted === true);
  const humanReviewGate = items.length === groundedAiQualificationV1Contract.scenarios &&
    items.every((item) => item.status === 'success' && item.humanReviewRequired === true);
  const confidenceGate = items.length === groundedAiQualificationV1Contract.scenarios && items.every((item) =>
    item.status === 'success' && item.schemaAccepted === true && item.parsedJson === true && item.validationReason !== 'invalid_confidence');
  const criteria: Record<string, boolean | null> = {
    exactScenarioSet: shapeValid,
    allSixRequestsCompleted: items.length === 6 && completed.length === 6 && failed.length === 0 && notAttempted.length === 0,
    allSixJsonSchemaParserAccepted: schemaParserGate,
    allSixRequireHumanReview: humanReviewGate,
    supportedCoverageThreeOfThree: supported.length === 3,
    insufficientEvidenceAbstentionThreeOfThree: abstained.length === 3,
    noFalseSupportedAnswers: falseSupported.length === 0,
    supportedCitationIdentityAndExpectedSourceCoverage: citationGate,
    exactClassificationAgreement: exactSupportedLabels,
    confidenceContractAccepted: confidenceGate,
    noTransportOrTimeoutFailure: failed.every((item) => item.failureStage !== 'provider_connection' &&
      item.failureStage !== 'provider_http' && item.failureStage !== 'generation_timeout'),
    datasetReviewManifestPresent: Number.isSafeInteger(review.datasetReview.attestationCount) &&
      review.datasetReview.attestationCount === groundedAiQualificationV1Contract.smokePassThresholds.independentDatasetReviewers &&
      review.datasetReview.manifestClaimsApproval &&
      /^[0-9a-f]{64}$/.test(review.datasetReview.datasetSha256) &&
      review.datasetReview.datasetSha256 === groundedAiQualificationV1DatasetSha256(),
    independentDatasetApprovalVerified: review.datasetReview.independentlyVerified === true ? true : null,
    independentSemanticReviewComplete: Number.isSafeInteger(review.semanticReview.independentReviewerCount) &&
      review.semanticReview.independentReviewerCount >= groundedAiQualificationV1Contract.smokePassThresholds.independentSemanticReviewers &&
      review.semanticReview.complete,
    semanticEntailmentClean: Number.isSafeInteger(review.semanticReview.independentReviewerCount) &&
      review.semanticReview.independentReviewerCount >= groundedAiQualificationV1Contract.smokePassThresholds.independentSemanticReviewers &&
      Number.isSafeInteger(review.semanticReview.entailmentFailures) && review.semanticReview.entailmentFailures === 0 &&
      review.semanticReview.complete,
  };
  const substantiveFailure = falseSupported.length > 0 || (supported.length > 0 && !exactSupportedLabels) ||
    (supported.length > 0 && !citationGate) ||
    (review.semanticReview.complete && review.semanticReview.independentReviewerCount >= 2 && review.semanticReview.entailmentFailures > 0) ||
    failed.some((item) => ['model_json_parse', 'output_schema'].includes(item.failureStage ?? '') ||
      item.validationReason === 'invalid_confidence') ||
    items.some((item) => item.status === 'success' && (item.parsedJson !== true || item.schemaAccepted !== true ||
      item.humanReviewRequired !== true || item.validationReason === 'invalid_confidence')) ||
    items.some((item) => item.expectedGroundingState === 'SUPPORTED' && item.status === 'success' && item.groundingState === 'INSUFFICIENT_EVIDENCE') ||
    items.some((item) => item.expectedGroundingState === 'INSUFFICIENT_EVIDENCE' && item.status === 'success' && item.groundingState !== 'INSUFFICIENT_EVIDENCE');
  const allOperationalCriteria = Object.entries(criteria).every(([key, value]) =>
    key === 'independentDatasetApprovalVerified' || key === 'independentSemanticReviewComplete' || key === 'semanticEntailmentClean' || value === true);
  const evidencePending = criteria.independentDatasetApprovalVerified !== true || criteria.independentSemanticReviewComplete !== true ||
    criteria.semanticEntailmentClean !== true;
  const decision: QualificationV1Decision = substantiveFailure ? 'FAIL' :
    allOperationalCriteria && !evidencePending ? 'PASS_SMOKE' : 'INCONCLUSIVE';
  return {
    decision,
    decisionQualityStatus: 'NOT_QUALIFIED',
    requestCount: items.filter((item) => item.status !== 'not_attempted').length,
    completedCount: completed.length,
    failedCount: failed.length,
    notAttemptedCount: notAttempted.length,
    criteria,
    metrics,
    outcomes,
  };
}

export interface QualificationV1ReportInput {
  source: QualificationV1SourceIdentity;
  status: 'in_progress' | 'inconclusive' | 'completed_pending_semantic_review';
  startedAt: string;
  finishedAt: string;
  ollamaVersion: string;
  modelManifestDigest: string;
  promptTemplateSha256: string;
  reviewEvidence: QualificationV1ReviewEvidence;
  evaluation: QualificationV1Evaluation;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`;
  }
  const result = JSON.stringify(value);
  if (result === undefined) throw new Error('qualification_canonical_json_invalid');
  return result;
}

/** Deterministic digest is computed over finalized content; it is not embedded recursively. */
export function createGroundedAiQualificationV1Report(input: QualificationV1ReportInput) {
  const startedAtMs = Date.parse(input.startedAt);
  const finishedAtMs = Date.parse(input.finishedAt);
  if (!Number.isFinite(startedAtMs) || !Number.isFinite(finishedAtMs) ||
      new Date(startedAtMs).toISOString() !== input.startedAt || new Date(finishedAtMs).toISOString() !== input.finishedAt ||
      Date.parse(input.finishedAt) < Date.parse(input.startedAt) || input.ollamaVersion !== groundedAiQualificationV1Contract.ollamaVersion ||
      input.modelManifestDigest !== groundedAiQualificationV1Contract.modelManifestDigest ||
      !/^[0-9a-f]{64}$/.test(input.promptTemplateSha256) ||
      input.source.baselineCommit !== groundedAiQualificationV1Contract.baselineCommit ||
      !/^[0-9a-f]{40}$/.test(input.source.codeCommit) || !/^[0-9a-f]{40}$/.test(input.source.treeHash) ||
      input.source.m422ReleaseCommit !== groundedAiQualificationV1Contract.m422ReleaseCommit ||
      input.source.m423ReleaseCommit !== groundedAiQualificationV1Contract.m423ReleaseCommit ||
      input.source.sourceIdentityReleaseCommit !== groundedAiQualificationV1Contract.sourceIdentityReleaseCommit ||
      input.source.sourceIdentityReviewedHead !== groundedAiQualificationV1Contract.sourceIdentityReviewedHead ||
      Object.keys(input.source.protectedFileSha256).length !== Object.keys(groundedAiQualificationV1ProtectedFileSha256).length +
        Object.keys(groundedAiQualificationV1ReviewedFileSha256).length ||
      Object.values(input.source.protectedFileSha256).some((hash) => !/^[0-9a-f]{64}$/.test(hash)) ||
      Object.entries({ ...groundedAiQualificationV1ProtectedFileSha256, ...groundedAiQualificationV1ReviewedFileSha256 })
        .some(([path, hash]) => input.source.protectedFileSha256[path] !== hash)) {
    throw new Error('qualification_report_provenance_invalid');
  }
  const report = {
    reportSchemaVersion: groundedAiQualificationV1Contract.reportSchemaVersion,
    evaluatorVersion: groundedAiQualificationV1Contract.evaluatorVersion,
    status: input.status,
    startedAt: input.startedAt,
    finishedAt: input.finishedAt,
    source: input.source,
    dataset: { version: groundedAiQualificationV1Contract.datasetVersion,
      labelProvenance: groundedAiQualificationV1Contract.labelProvenance,
      datasetSha256: groundedAiQualificationV1DatasetSha256(),
      scenarioCount: groundedAiQualificationV1Contract.scenarios,
      reviewerAttestationCount: input.reviewEvidence.datasetReview.attestationCount,
      reviewManifestClaimsApproval: input.reviewEvidence.datasetReview.manifestClaimsApproval,
      independentApprovalVerified: input.reviewEvidence.datasetReview.independentlyVerified,
      reviewedDatasetSha256: input.reviewEvidence.datasetReview.datasetSha256 },
    model: { tag: groundedAiQualificationV1Contract.model, manifestDigest: input.modelManifestDigest,
      ollamaVersion: input.ollamaVersion },
    promptTemplateSha256: input.promptTemplateSha256,
    runtime: { endpoint: groundedAiQualificationV1Contract.endpoint,
      maximumRequests: groundedAiQualificationV1Contract.maximumRequests,
      maximumAttemptsPerScenario: groundedAiQualificationV1Contract.maximumAttemptsPerScenario,
      maximumConcurrency: groundedAiQualificationV1Contract.maximumConcurrency,
      retryCount: groundedAiQualificationV1Contract.retryCount,
      timeoutMs: groundedAiQualificationV1Contract.timeoutMs,
      temperature: groundedAiQualificationV1Contract.temperature,
      numPredict: groundedAiQualificationV1Contract.numPredict },
    evaluation: input.evaluation,
    independentSemanticReview: { reviewerCount: input.reviewEvidence.semanticReview.independentReviewerCount,
      complete: input.reviewEvidence.semanticReview.complete,
      entailmentFailures: input.reviewEvidence.semanticReview.entailmentFailures },
    limitations: [
      'Six synthetic scenarios are a smoke test, not a generalizable accuracy benchmark.',
      'A passing smoke result only permits consideration of a larger independently reviewed evaluation.',
      'The balanced runner supplies fixed synthetic sources directly; it does not evaluate live database retrieval, Auth0, tenant authorization, RLS, or browser behavior.',
      'Citation identity and expected-source coverage do not establish semantic entailment.',
      'Decision quality remains NOT_QUALIFIED.',
    ],
  };
  const reportSha256 = createHash('sha256').update(canonicalJson(report), 'utf8').digest('hex');
  return { ...report, reportSha256 };
}

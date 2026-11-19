import { createHash } from 'node:crypto';
import { groundedBalancedDatasetVersion, groundedBalancedLabelStatus, groundedBalancedScenarios } from './grounded-balanced-dataset.js';
import { groundedValidationReasons } from '../grounded-analysis.js';
import { createBalancedObservation, scoreGroundedBalancedEvaluation, type BalancedObservation } from './grounded-balanced-scoring.js';
import type { BalancedAttempt } from './grounded-balanced-runner.js';
import { groundedAiQualificationV1Contract, groundedAiQualificationV1ProtectedFileSha256,
  groundedAiQualificationV1ReviewedFileSha256, type QualificationV1SourceIdentity } from './grounded-ai-qualification-v1.js';

export const aiAssistedExploratoryEvaluationV1ReportRelativePath =
  '.local/evaluations/ai-assisted-exploratory-grounded-qwen2.5-3b-instruct-v1.json';

export const aiAssistedExploratoryEvaluationV1Contract = Object.freeze({
  evaluatorVersion: 'aegis-ai-assisted-exploratory-evaluation-v1',
  reportSchemaVersion: 'aegis-ai-assisted-exploratory-report-v1',
  approvedBaseCommit: '4c25c462adf1916af7ca0a41dc1a8092ac49d5f6',
  datasetVersion: groundedBalancedDatasetVersion,
  datasetSha256: '6774f2b64c1d9e082529626420d94718209d387aa8b689ff69a03d0881b473bb',
  labelProvenance: groundedBalancedLabelStatus,
  model: 'qwen2.5:3b-instruct',
  modelManifestDigest: 'sha256:357c53fb659c5076de1d65ccb0b397446227b71a42be9d1603d46168015c9e4b',
  ollamaVersion: '0.40.15',
  endpoint: 'http://127.0.0.1:11434/api/generate',
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
  externalAiCritiques: Object.freeze([
    Object.freeze({ modelId: 'Claude Sonnet 5.5', reviewType: 'preliminary classification critique',
      reportSha256: 'f3122a058024f6cb165e041a9782feb22b13b81034ebc3f888120545ccbbbe2d',
      datasetSha256: '6774f2b64c1d9e082529626420d94718209d387aa8b689ff69a03d0881b473bb',
      provenance: 'reported_external_ai_critique_not_human_approval' }),
    Object.freeze({ modelId: 'GPT-6-family', reviewType: 'context-isolated blinded evidence critique',
      reportSha256: 'd0cb6677cd0c08cbb520f3bc2ed8fe53137943a0b036fda4fbe96893dabef1e7',
      datasetSha256: '6774f2b64c1d9e082529626420d94718209d387aa8b689ff69a03d0881b473bb',
      provenance: 'reported_external_ai_critique_not_human_approval' }),
  ]),
  // This pin is updated only after the CLI source is finalized and independently reviewed.
  reviewedRunnerSha256: '4bb65c79be84323a1ae1aa1ea8c196d21aeb4387633dea2acb2ece58e5a9877e',
} as const);

export type ExploratoryGitRead = (args: readonly string[]) => string;
export type ExploratoryBlobSha256 = (ref: string, path: string) => string;

export interface AiAssistedExploratorySourceIdentity extends QualificationV1SourceIdentity {
  exploratoryRunnerSha256: string;
  exploratoryRunnerReleaseCommit: string;
  repositoryBaseCommit: string;
}

function sourceError(code: string): never {
  throw new Error(`exploratory_source_${code}`);
}

/**
 * The Qualification V1 verifier checks the established immutable release anchors and the
 * clean synchronized main identity. This additional pin binds the separate exploratory CLI
 * to the exact reviewed release blob. It does not prove that external GitHub CI passed.
 */
export function verifyAiAssistedExploratoryRunnerIdentity(
  readGit: ExploratoryGitRead,
  readBlobSha256: ExploratoryBlobSha256,
  releaseSha: string,
  localRunnerSha256: string,
): { releaseCommit: string; runnerSha256: string } {
  if (!/^[0-9a-f]{40}$/.test(releaseSha)) sourceError('release_sha_invalid');
  let approvedBase: string;
  try { approvedBase = readGit(['rev-parse', `${aiAssistedExploratoryEvaluationV1Contract.approvedBaseCommit}^{commit}`]).trim(); }
  catch { sourceError('approved_base_ref_missing'); }
  if (approvedBase !== aiAssistedExploratoryEvaluationV1Contract.approvedBaseCommit) sourceError('approved_base_ref_mismatch');
  try { readGit(['merge-base', '--is-ancestor', aiAssistedExploratoryEvaluationV1Contract.approvedBaseCommit, releaseSha]); }
  catch { sourceError('approved_base_not_ancestor'); }
  if (!/^[0-9a-f]{64}$/.test(aiAssistedExploratoryEvaluationV1Contract.reviewedRunnerSha256) ||
      localRunnerSha256 !== aiAssistedExploratoryEvaluationV1Contract.reviewedRunnerSha256) {
    sourceError('runner_pin_invalid');
  }
  let releaseRunnerSha256: string;
  try {
    releaseRunnerSha256 = readBlobSha256(releaseSha,
      'apps/api/src/ai/evaluation/run-ai-assisted-exploratory-evaluation-v1-local.ts');
  } catch {
    sourceError('runner_blob_missing');
  }
  if (releaseRunnerSha256 !== aiAssistedExploratoryEvaluationV1Contract.reviewedRunnerSha256) {
    sourceError('runner_blob_mismatch');
  }
  return { releaseCommit: releaseSha, runnerSha256: localRunnerSha256 };
}

export interface ExploratoryMachineContract {
  requestLimit: number;
  attemptsPerScenarioLimit: number;
  concurrencyLimit: number;
  retries: number;
  timeoutMs: number;
  temperature: number;
  numPredict: number;
  loopbackEndpoint: string;
  cloudFallback: 'prohibited';
  externalActions: 'prohibited';
  humanReviewRequiredForRecommendations: boolean;
}

const allowedFailureStages = ['provider_connection', 'provider_http', 'response_size', 'response_decode', 'response_envelope',
  'model_json_parse', 'output_schema', 'generation_timeout', 'request_cancelled', 'input_validation', 'unknown'] as const;

function safeFailureStage(value: unknown): string | null {
  return typeof value === 'string' && allowedFailureStages.includes(value as typeof allowedFailureStages[number]) ? value : null;
}

function safeValidationReason(value: unknown): string | null {
  return typeof value === 'string' && groundedValidationReasons.includes(value as never) ? value : null;
}

function safeAttempt(attempt: BalancedAttempt, observation: BalancedObservation) {
  const supported = observation.status === 'success' && observation.schemaAccepted === true &&
    observation.groundingState === 'SUPPORTED' && observation.expected !== null;
  const expected = observation.expected;
  return {
    scenarioId: observation.scenarioId,
    requestStatus: attempt.status,
    jsonParseAccepted: observation.parsedJson,
    schemaAccepted: observation.schemaAccepted,
    groundingState: observation.groundingState,
    humanReviewEnforced: observation.humanReviewRequired,
    citationIdentityValid: observation.citationsValid,
    citationCount: attempt.citationCount ?? null,
    expectedSourceIdentityCoverage: supported ? {
      matched: observation.citedExpectedSourceIdentities.length,
      expected: observation.expectedSourceIdentities.length,
      allExpectedIdentitiesCited: observation.expectedSourceIdentities.length > 0 &&
        observation.citedExpectedSourceIdentities.length === observation.expectedSourceIdentities.length,
    } : null,
    classificationAgreement: supported ? {
      category: attempt.category === expected?.category,
      priority: attempt.priority === expected?.priority,
      recommendedTeam: attempt.recommendedTeam === expected?.recommendedTeam,
      advisoryNextAction: attempt.nextAction === expected?.nextAction,
    } : null,
    failureStage: safeFailureStage(attempt.failureStage),
    validationReason: safeValidationReason(attempt.validationReason),
    latencyMs: Number.isSafeInteger(attempt.latencyMs) && attempt.latencyMs! >= 0 && attempt.latencyMs! <= 60_000 ? attempt.latencyMs : null,
    promptTokens: Number.isSafeInteger(attempt.promptTokens) && attempt.promptTokens! >= 0 ? attempt.promptTokens : null,
    generatedTokens: Number.isSafeInteger(attempt.generatedTokens) && attempt.generatedTokens! >= 0 ? attempt.generatedTokens : null,
    correlationComplete: attempt.correlationComplete,
  };
}

export function createAiAssistedExploratoryEvaluationV1Report(input: {
  status: 'in_progress' | 'completed_exploratory' | 'incomplete';
  startedAt: string;
  finishedAt: string;
  ollamaVersion: string;
  source: AiAssistedExploratorySourceIdentity;
  machineContract: ExploratoryMachineContract;
  attempts: readonly BalancedAttempt[];
  observations: readonly BalancedObservation[];
}) {
  const startedAt = Date.parse(input.startedAt);
  const finishedAt = Date.parse(input.finishedAt);
  const source = input.source;
  const sourceShas = [source.baselineCommit, source.m422ReleaseCommit, source.m423ReleaseCommit,
    source.sourceIdentityReleaseCommit, source.sourceIdentityReviewedHead, source.codeCommit, source.treeHash,
    source.exploratoryRunnerReleaseCommit];
  const expectedProtectedHashes = { ...groundedAiQualificationV1ProtectedFileSha256,
    ...groundedAiQualificationV1ReviewedFileSha256 };
  const protectedHashesValid = Object.entries(expectedProtectedHashes).every(([path, expectedHash]) =>
    source.protectedFileSha256[path] === expectedHash && /^[0-9a-f]{64}$/.test(source.protectedFileSha256[path] ?? ''));
  if (!Number.isFinite(startedAt) || !Number.isFinite(finishedAt) ||
      new Date(startedAt).toISOString() !== input.startedAt || new Date(finishedAt).toISOString() !== input.finishedAt ||
      finishedAt < startedAt || input.ollamaVersion !== aiAssistedExploratoryEvaluationV1Contract.ollamaVersion ||
      source.baselineCommit !== groundedAiQualificationV1Contract.baselineCommit ||
      source.m422ReleaseCommit !== groundedAiQualificationV1Contract.m422ReleaseCommit ||
      source.m423ReleaseCommit !== groundedAiQualificationV1Contract.m423ReleaseCommit ||
      source.sourceIdentityReleaseCommit !== groundedAiQualificationV1Contract.sourceIdentityReleaseCommit ||
      source.sourceIdentityReviewedHead !== groundedAiQualificationV1Contract.sourceIdentityReviewedHead ||
      source.repositoryBaseCommit !== aiAssistedExploratoryEvaluationV1Contract.approvedBaseCommit ||
      source.codeCommit !== source.exploratoryRunnerReleaseCommit ||
      source.exploratoryRunnerSha256 !== aiAssistedExploratoryEvaluationV1Contract.reviewedRunnerSha256 ||
      sourceShas.some((sha) => !/^[0-9a-f]{40}$/.test(sha)) ||
      !protectedHashesValid ||
      input.machineContract.requestLimit !== aiAssistedExploratoryEvaluationV1Contract.maximumRequests ||
      input.machineContract.attemptsPerScenarioLimit !== aiAssistedExploratoryEvaluationV1Contract.maximumAttemptsPerScenario ||
      input.machineContract.concurrencyLimit !== aiAssistedExploratoryEvaluationV1Contract.maximumConcurrency ||
      input.machineContract.retries !== aiAssistedExploratoryEvaluationV1Contract.retryCount ||
      input.machineContract.timeoutMs !== aiAssistedExploratoryEvaluationV1Contract.timeoutMs ||
      input.machineContract.temperature !== aiAssistedExploratoryEvaluationV1Contract.temperature ||
      input.machineContract.numPredict !== aiAssistedExploratoryEvaluationV1Contract.numPredict ||
      input.machineContract.loopbackEndpoint !== aiAssistedExploratoryEvaluationV1Contract.endpoint ||
      input.machineContract.cloudFallback !== 'prohibited' || input.machineContract.externalActions !== 'prohibited' ||
      input.machineContract.humanReviewRequiredForRecommendations !== true) {
    throw new Error('exploratory_report_contract_invalid');
  }
  const expectedIds = groundedBalancedScenarios.map((item) => item.scenarioId);
  const attemptById = new Map(input.attempts.map((item) => [item.scenarioId, item]));
  const observationById = new Map(input.observations.map((item) => [item.scenarioId, item]));
  if (input.attempts.length > expectedIds.length || input.observations.length > expectedIds.length ||
      new Set(input.attempts.map((item) => item.scenarioId)).size !== input.attempts.length ||
      new Set(input.observations.map((item) => item.scenarioId)).size !== input.observations.length ||
      input.attempts.some((item) => !expectedIds.includes(item.scenarioId)) ||
      input.observations.some((item) => !expectedIds.includes(item.scenarioId)) ||
      input.attempts.length !== input.observations.length ||
      input.attempts.some((item) => !['success', 'failure', 'not_attempted'].includes(item.status)) ||
      input.observations.some((item) => !['success', 'failure', 'not_attempted'].includes(item.status)) ||
      input.attempts.some((item) => !observationById.has(item.scenarioId)) ||
      input.observations.some((item) => !attemptById.has(item.scenarioId))) {
    throw new Error('exploratory_report_scenarios_invalid');
  }
  const orderedAttempts = expectedIds.map((id) => attemptById.get(id) ?? ({ scenarioId: id,
    status: 'not_attempted' as const, latencyMs: null, promptTokens: null, generatedTokens: null, correlationComplete: false }));
  const orderedObservations = expectedIds.map((id, index) => observationById.get(id) ??
    createBalancedObservation(groundedBalancedScenarios[index]!, 'not_attempted'));
  const score = scoreGroundedBalancedEvaluation(orderedObservations);
  const attempts = orderedAttempts.map((attempt, index) => safeAttempt(attempt, orderedObservations[index]!));
  const requestCount = attempts.filter((item) => item.requestStatus !== 'not_attempted').length;
  if (requestCount > aiAssistedExploratoryEvaluationV1Contract.maximumRequests) {
    throw new Error('exploratory_report_request_limit_exceeded');
  }
  if (input.status === 'completed_exploratory' && requestCount !== aiAssistedExploratoryEvaluationV1Contract.scenarios) {
    throw new Error('exploratory_report_completion_invalid');
  }
  const machineContractComplete = attempts.length === 6 && attempts.every((item) => item.requestStatus === 'success' &&
    item.jsonParseAccepted === true && item.schemaAccepted === true && item.humanReviewEnforced === true);
  const report = {
    reportSchemaVersion: aiAssistedExploratoryEvaluationV1Contract.reportSchemaVersion,
    evaluatorVersion: aiAssistedExploratoryEvaluationV1Contract.evaluatorVersion,
    status: input.status,
    qualificationStatus: 'NOT_QUALIFIED' as const,
    interpretation: 'AI_ASSISTED_EXPLORATORY_ONLY' as const,
    startedAt: input.startedAt,
    finishedAt: input.finishedAt,
    source,
    dataset: {
      version: aiAssistedExploratoryEvaluationV1Contract.datasetVersion,
      sha256: aiAssistedExploratoryEvaluationV1Contract.datasetSha256,
      scenarioCount: aiAssistedExploratoryEvaluationV1Contract.scenarios,
      sourceCount: aiAssistedExploratoryEvaluationV1Contract.distinctSources,
      labelProvenance: groundedBalancedLabelStatus,
      humanApprovalStatus: 'NOT_VERIFIED' as const,
      priorAiCritiques: {
        provenanceStatus: 'reported_external_artifacts_not_independently_verified' as const,
        artifacts: aiAssistedExploratoryEvaluationV1Contract.externalAiCritiques,
        humanApproval: 'NOT_VERIFIED' as const,
      },
    },
    model: {
      tag: aiAssistedExploratoryEvaluationV1Contract.model,
      manifestDigest: aiAssistedExploratoryEvaluationV1Contract.modelManifestDigest,
      ollamaVersion: input.ollamaVersion,
      providerSourceSha256: source.protectedFileSha256['apps/api/src/ai/grounded-provider.ts'],
    },
    runtime: input.machineContract,
    machineContract: {
      status: machineContractComplete ? 'complete' as const : 'incomplete_or_failed' as const,
      providerInvocationCount: requestCount,
      maximumProviderInvocations: aiAssistedExploratoryEvaluationV1Contract.maximumRequests,
      attemptedOncePerScenario: attempts.every((item) => item.requestStatus !== 'not_attempted'),
      sequentialConcurrencyOne: true,
      retries: 0,
      parserSchemaAndHumanReviewAreMachineChecksOnly: true,
    },
    exploratoryComparison: {
      labelBasis: 'Frozen engineering labels with external AI-assisted critique; ground truth not independently human-established.',
      metrics: score.metrics,
      attempts,
      decisionQualityStatus: 'NOT_QUALIFIED' as const,
      semanticEvidenceValidation: 'NOT_ASSESSED' as const,
      categoryTaxonomyMapping: 'NOT_HUMAN_VERIFIED' as const,
      abstentionCitationScoringLimitation: 'Expected source identity sets are empty for abstention labels; interpret abstention source behavior separately and do not equate that with failed evidence identity without review.',
    },
    limitations: [
      'This is AI-assisted exploratory provider-level testing, not human-approved dataset validation or model qualification.',
      'Agreement with engineering labels and prior AI critiques does not prove those labels are correct.',
      'The six synthetic cases are strongly answer-cued and are not a production benchmark.',
      'Semantic entailment, category taxonomy mapping, and answer-cue effects require human judgment and are not measured by this report.',
      'This runner does not evaluate authenticated API, Auth0, database/RLS, retrieval, browser, or production workflows.',
      'Recommendations are advisory, require human review, and trigger no case or external action.',
      'No prompt, case facts, evidence content, model rationale, raw response, token, or credential is stored.',
      'Externally verified GitHub CI and exact release approval must be checked separately; runtime source hashes do not prove human review or CI.',
    ],
  };
  const canonical = JSON.stringify(report);
  return { ...report, reportSha256: createHash('sha256').update(canonical, 'utf8').digest('hex') };
}

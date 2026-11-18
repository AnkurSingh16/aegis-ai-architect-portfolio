import { createHash, randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createGroundedAiQualificationV1Report,
  evaluateGroundedAiQualificationV1,
  groundedAiQualificationV1Contract as contract,
  groundedAiQualificationV1DatasetSha256,
  groundedAiQualificationV1ProtectedFileSha256,
  groundedAiQualificationV1ReviewedFileSha256,
  groundedAiQualificationV1ReportRelativePath,
  verifyGroundedAiQualificationV1Source,
  type QualificationGitRead,
  type QualificationV1SourceIdentity,
} from './grounded-ai-qualification-v1.js';
import { runGroundedBalancedEvaluation } from './grounded-balanced-runner.js';
import { createBalancedObservation } from './grounded-balanced-scoring.js';
import { groundedBalancedScenarios } from './grounded-balanced-dataset.js';
import { reservePrivateReport } from './private-report.js';
import { assertQualificationV1LocalTransport, parseGroundedAiQualificationV1DatasetReview } from './run-grounded-ai-qualification-v1-local.js';

const releaseSha = 'a'.repeat(40);
const treeSha = 'b'.repeat(40);
const sourceHash = 'c'.repeat(64);
const approvedCommits = [contract.baselineCommit, contract.m422ReleaseCommit, contract.m423ReleaseCommit,
  contract.sourceIdentityReleaseCommit, contract.sourceIdentityReviewedHead];

function fakeGit(options: { branch?: string; dirty?: string; head?: string; origin?: string; live?: string;
  missingCommit?: string; failedAncestor?: string } = {}): QualificationGitRead {
  return (args) => {
    const command = args.join(' ');
    if (command === 'branch --show-current') return options.branch ?? 'main';
    if (command === 'status --porcelain=v1') return options.dirty ?? '';
    if (command === 'rev-parse HEAD') return options.head ?? releaseSha;
    if (command === 'rev-parse HEAD^{tree}') return treeSha;
    if (command === 'rev-parse origin/main') return options.origin ?? releaseSha;
    if (command === 'rev-parse origin/main^{tree}') return treeSha;
    if (command === 'ls-remote origin refs/heads/main') return options.live ?? `${releaseSha}\trefs/heads/main`;
    if (command.startsWith('rev-parse ') && command.endsWith('^{commit}')) {
      const ref = command.slice('rev-parse '.length, -'^{commit}'.length);
      if (ref === options.missingCommit) throw new Error('missing');
      if ((approvedCommits as readonly string[]).includes(ref)) return ref;
      throw new Error('unknown commit');
    }
    if (command.startsWith('merge-base --is-ancestor ')) {
      const [, , ancestor] = args;
      if (ancestor === options.failedAncestor) throw new Error('not ancestor');
      return '';
    }
    throw new Error(`unexpected mocked git command: ${command}`);
  };
}

function fakeBlob(options: { alteredPath?: string; missingPath?: string } = {}) {
  return (ref: string, path: string): string => {
    if (path === options.missingPath) throw new Error('missing blob');
    if (path === options.alteredPath) return 'd'.repeat(64);
    if (ref === contract.sourceIdentityReviewedHead &&
        path === 'apps/api/src/ai/evaluation/run-grounded-supported-output-diagnostic-local.ts') {
      return contract.sourceIdentityReviewedRunnerSha256;
    }
    if (ref === releaseSha && path in groundedAiQualificationV1ReviewedFileSha256) {
      return groundedAiQualificationV1ReviewedFileSha256[path as keyof typeof groundedAiQualificationV1ReviewedFileSha256];
    }
    if (ref === contract.baselineCommit || ref === releaseSha) return groundedAiQualificationV1ProtectedFileSha256[path as keyof typeof groundedAiQualificationV1ProtectedFileSha256];
    throw new Error('unapproved blob ref');
  };
}

const reviewEvidence = {
  datasetReview: { datasetSha256: groundedAiQualificationV1DatasetSha256(), attestationCount: 2,
    manifestClaimsApproval: true, independentlyVerified: true },
  semanticReview: { independentReviewerCount: 2, complete: true, entailmentFailures: 0 },
};

function completeObservations() {
  return groundedBalancedScenarios.map((scenario) => {
    if (scenario.expectedGroundingState === 'SUPPORTED') {
      return createBalancedObservation(scenario, 'success', { groundingState: 'SUPPORTED', parsedJson: true, schemaAccepted: true,
        citationsValid: true, citedExpectedSourceIdentities: [...scenario.expectedSourceIdentities], humanReviewRequired: true,
        correlationComplete: true, category: scenario.expected!.category, priority: scenario.expected!.priority,
        recommendedTeam: scenario.expected!.recommendedTeam, nextAction: scenario.expected!.nextAction,
        latencyMs: 900, promptTokens: 40, generatedTokens: 24 });
    }
    return createBalancedObservation(scenario, 'success', { groundingState: 'INSUFFICIENT_EVIDENCE', parsedJson: true, schemaAccepted: true,
      citationsValid: null, humanReviewRequired: true, correlationComplete: true, latencyMs: 800, promptTokens: 35, generatedTokens: 15 });
  });
}

function sourceIdentity(): QualificationV1SourceIdentity {
  return { baselineCommit: contract.baselineCommit, m422ReleaseCommit: contract.m422ReleaseCommit,
    m423ReleaseCommit: contract.m423ReleaseCommit, sourceIdentityReleaseCommit: contract.sourceIdentityReleaseCommit,
    sourceIdentityReviewedHead: contract.sourceIdentityReviewedHead, codeCommit: releaseSha, treeHash: treeSha,
    protectedFileSha256: { ...groundedAiQualificationV1ProtectedFileSha256, ...groundedAiQualificationV1ReviewedFileSha256 } };
}

describe('Grounded AI Qualification V1 source identity', () => {
  it('accepts only the explicitly supplied clean synchronized release with exact pinned sources', () => {
    const result = verifyGroundedAiQualificationV1Source(fakeGit(), fakeBlob(), releaseSha);
    expect(result).toMatchObject({ codeCommit: releaseSha, treeHash: treeSha, baselineCommit: contract.baselineCommit });
    expect(Object.keys(result.protectedFileSha256)).toEqual([
      ...Object.keys(groundedAiQualificationV1ProtectedFileSha256), ...Object.keys(groundedAiQualificationV1ReviewedFileSha256),
    ]);
  });

  it.each([
    ['dirty checkout', fakeGit({ dirty: ' M protected.ts' }), fakeBlob(), releaseSha, /dirty_checkout/],
    ['unexpected branch', fakeGit({ branch: 'feat/other' }), fakeBlob(), releaseSha, /main_required/],
    ['unsynchronized HEAD', fakeGit({ head: 'e'.repeat(40) }), fakeBlob(), releaseSha, /unsupported_or_unsynchronized_release/],
    ['moved origin ref', fakeGit({ origin: 'e'.repeat(40) }), fakeBlob(), releaseSha, /unsupported_or_unsynchronized_release/],
    ['moved live main', fakeGit({ live: `${'e'.repeat(40)}\trefs/heads/main` }), fakeBlob(), releaseSha, /unsupported_or_unsynchronized_release/],
    ['invalid expected release', fakeGit(), fakeBlob(), 'not-a-commit', /release_sha_required/],
    ['missing approved commit', fakeGit({ missingCommit: contract.m423ReleaseCommit }), fakeBlob(), releaseSha, /approved_ref_missing/],
    ['missing ancestry', fakeGit({ failedAncestor: contract.m422ReleaseCommit }), fakeBlob(), releaseSha, /approved_release_not_ancestor/],
    ['reviewed source head not descended from its pinned release',
      fakeGit({ failedAncestor: contract.sourceIdentityReleaseCommit }), fakeBlob(), releaseSha, /approved_release_not_ancestor/],
    ['modified protected file', fakeGit(), fakeBlob({ alteredPath: 'apps/api/src/ai/grounded-provider.ts' }), releaseSha,
      /protected_file_hash_mismatch/],
    ['missing protected file', fakeGit(), fakeBlob({ missingPath: 'apps/api/src/ai/grounded-analysis.ts' }), releaseSha,
      /protected_file_missing/],
    ['unreviewed source-gate anchor', fakeGit(), (ref, path) => ref === contract.sourceIdentityReviewedHead ? 'e'.repeat(64) : fakeBlob()(ref, path),
      releaseSha, /reviewed_gate_anchor_mismatch/],
    ['modified qualification runner', fakeGit(), fakeBlob({ alteredPath: 'apps/api/src/ai/evaluation/run-grounded-ai-qualification-v1-local.ts' }),
      releaseSha, /reviewed_source_hash_mismatch/],
    ['missing qualification runner', fakeGit(), fakeBlob({ missingPath: 'apps/api/src/ai/evaluation/run-grounded-ai-qualification-v1-local.ts' }),
      releaseSha, /reviewed_source_missing/],
  ])('rejects %s', (_name, readGit, readBlob, expectedSha, error) => {
    expect(() => verifyGroundedAiQualificationV1Source(readGit, readBlob, expectedSha)).toThrow(error);
  });
});

describe('Grounded AI Qualification V1 frozen contract and scoring', () => {
  it('preserves the six natural two-branch scenarios and exact runtime budget', () => {
    expect(contract).toMatchObject({ model: 'qwen2.5:3b-instruct', scenarios: 6, expectedSupported: 3,
      expectedInsufficientEvidence: 3, distinctSources: 13, maximumRequests: 6, maximumAttemptsPerScenario: 1,
      maximumConcurrency: 1, retryCount: 0, timeoutMs: 15000, temperature: 0.1, numPredict: 256,
      naturalTwoBranchSchema: true });
    expect(groundedBalancedScenarios.filter((item) => item.expectedGroundingState === 'SUPPORTED')).toHaveLength(3);
    expect(groundedBalancedScenarios.filter((item) => item.expectedGroundingState === 'INSUFFICIENT_EVIDENCE')).toHaveLength(3);
  });

  it('passes only the predeclared six-case smoke contract and leaves decision quality unqualified', () => {
    const result = evaluateGroundedAiQualificationV1(completeObservations(), reviewEvidence);
    expect(result.decision).toBe('PASS_SMOKE');
    expect(result.decisionQualityStatus).toBe('NOT_QUALIFIED');
    expect(result.requestCount).toBe(6);
    expect(result.completedCount).toBe(6);
    expect(result.criteria).toMatchObject({ allSixRequestsCompleted: true, allSixJsonSchemaParserAccepted: true,
      allSixRequireHumanReview: true, supportedCoverageThreeOfThree: true,
      insufficientEvidenceAbstentionThreeOfThree: true, noFalseSupportedAnswers: true,
      supportedCitationIdentityAndExpectedSourceCoverage: true, exactClassificationAgreement: true,
      confidenceContractAccepted: true, semanticEntailmentClean: true });
    expect(result.outcomes.filter((item) => item.groundingState === 'INSUFFICIENT_EVIDENCE')
      .every((item) => Object.values(item.classificationFieldAgreement).every((value) => value === null))).toBe(true);
  });

  it('fails false-supported answers, wrong supported labels, invalid citations, and incorrect abstentions', () => {
    const baseline = completeObservations();
    const insufficientIndex = baseline.findIndex((item) => item.expectedGroundingState === 'INSUFFICIENT_EVIDENCE');
    const falseSupported = [...baseline];
    falseSupported[insufficientIndex] = { ...falseSupported[insufficientIndex]!, status: 'success', groundingState: 'SUPPORTED' };
    expect(evaluateGroundedAiQualificationV1(falseSupported, reviewEvidence).decision).toBe('FAIL');

    const wrongLabel = [...baseline];
    const supportedIndex = wrongLabel.findIndex((item) => item.expectedGroundingState === 'SUPPORTED');
    wrongLabel[supportedIndex] = { ...wrongLabel[supportedIndex]!, priority: 'low' };
    expect(evaluateGroundedAiQualificationV1(wrongLabel, reviewEvidence).decision).toBe('FAIL');

    const invalidCitation = [...baseline];
    invalidCitation[supportedIndex] = { ...invalidCitation[supportedIndex]!, citationsValid: false };
    expect(evaluateGroundedAiQualificationV1(invalidCitation, reviewEvidence).decision).toBe('FAIL');
    expect(evaluateGroundedAiQualificationV1(invalidCitation, reviewEvidence).outcomes[supportedIndex]?.citationIdentityValid).toBe(false);

    const wrongAbstention = [...baseline];
    wrongAbstention[supportedIndex] = { ...wrongAbstention[supportedIndex]!, groundingState: 'INSUFFICIENT_EVIDENCE' };
    expect(evaluateGroundedAiQualificationV1(wrongAbstention, reviewEvidence).decision).toBe('FAIL');
  });

  it('keeps pending human evidence inconclusive and reports zero-denominator metrics as null', () => {
    const notAttempted = groundedBalancedScenarios.map((scenario) => createBalancedObservation(scenario, 'not_attempted'));
    const pending = { ...reviewEvidence, semanticReview: { independentReviewerCount: 0, complete: false, entailmentFailures: 0 } };
    const result = evaluateGroundedAiQualificationV1(notAttempted, pending);
    expect(result.decision).toBe('INCONCLUSIVE');
    expect(result.notAttemptedCount).toBe(6);
    expect(result.metrics.metrics.citationIdentityValidity.rate).toBeNull();
    expect(result.metrics.metrics.semanticGroundednessReview.rate).toBeNull();
    expect(result.metrics.metrics.semanticGroundednessReview.state).toBe('not_measured');
  });

  it('does not treat a structurally valid local manifest as independent human verification', () => {
    const attestationOnly = { ...reviewEvidence, datasetReview: { ...reviewEvidence.datasetReview, independentlyVerified: false } };
    const result = evaluateGroundedAiQualificationV1(completeObservations(), attestationOnly);
    expect(result.criteria.datasetReviewManifestPresent).toBe(true);
    expect(result.criteria.independentDatasetApprovalVerified).toBeNull();
    expect(result.decision).toBe('INCONCLUSIVE');
    expect(result.decisionQualityStatus).toBe('NOT_QUALIFIED');
  });
});

describe('Grounded AI Qualification V1 report and review artifacts', () => {
  it('hashes deterministic report content without a self-referential digest or source text', () => {
    const evaluation = evaluateGroundedAiQualificationV1(completeObservations(), {
      ...reviewEvidence, semanticReview: { independentReviewerCount: 0, complete: false, entailmentFailures: 0 },
    });
    const input = { source: sourceIdentity(), status: 'completed_pending_semantic_review' as const,
      startedAt: '2026-11-16T00:00:00.000Z', finishedAt: '2026-11-16T00:01:00.000Z',
      ollamaVersion: contract.ollamaVersion, modelManifestDigest: contract.modelManifestDigest,
      promptTemplateSha256: sourceHash, reviewEvidence: { ...reviewEvidence,
        semanticReview: { independentReviewerCount: 0, complete: false, entailmentFailures: 0 } }, evaluation };
    const first = createGroundedAiQualificationV1Report(input);
    const second = createGroundedAiQualificationV1Report(input);
    expect(first.reportSha256).toBe(second.reportSha256);
    expect(first.status).toBe('completed_pending_semantic_review');
    expect(first.evaluation.decision).toBe('INCONCLUSIVE');
    expect(first.evaluation.decisionQualityStatus).toBe('NOT_QUALIFIED');
    expect(() => createGroundedAiQualificationV1Report({ ...input, source: { ...input.source, m422ReleaseCommit: 'f'.repeat(40) } }))
      .toThrow(/qualification_report_provenance_invalid/);
    expect(() => createGroundedAiQualificationV1Report({ ...input, source: { ...input.source, protectedFileSha256:
      { ...input.source.protectedFileSha256, 'apps/api/src/ai/grounded-provider.ts': 'f'.repeat(64) } } }))
      .toThrow(/qualification_report_provenance_invalid/);
    const { reportSha256, ...payload } = first;
    const canonical = (value: unknown): string => Array.isArray(value) ? `[${value.map(canonical).join(',')}]` :
      value !== null && typeof value === 'object' ? `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}` : JSON.stringify(value);
    expect(createHash('sha256').update(canonical(payload)).digest('hex')).toBe(reportSha256);
    const serialized = JSON.stringify(first);
    for (const scenario of groundedBalancedScenarios) {
      expect(serialized).not.toContain(scenario.caseFacts);
      expect(serialized).not.toContain(scenario.reviewRationale);
      for (const source of scenario.sources) expect(serialized).not.toContain(source.content);
    }
    expect(groundedAiQualificationV1ReportRelativePath).toBe(
      '.local/evaluations/grounded-ai-qualification-qwen2.5-3b-instruct-v1.json');
  });

  it('accepts only a complete two-reviewer dataset manifest bound to the frozen dataset digest', () => {
    const reviewer = (reviewerId: string) => ({ reviewerId, datasetSha256: groundedAiQualificationV1DatasetSha256(),
      scenarioReviews: groundedBalancedScenarios.map((scenario) => ({ scenarioId: scenario.scenarioId,
        expectedGroundingState: scenario.expectedGroundingState, decision: 'approve',
        expectedSourceIdentities: [...scenario.expectedSourceIdentities].sort(),
        abstentionJustified: scenario.expectedGroundingState === 'INSUFFICIENT_EVIDENCE' ? true : null,
        classificationFields: scenario.expectedGroundingState === 'SUPPORTED'
          ? { category: true, priority: true, recommendedTeam: true, nextAction: true }
          : { category: null, priority: null, recommendedTeam: null, nextAction: null } })) });
    const manifest = { schemaVersion: 'aegis-grounded-ai-dataset-review-v1', datasetSha256: groundedAiQualificationV1DatasetSha256(),
      adjudication: 'approved', reviewers: [reviewer('REVIEWER_A'), reviewer('REVIEWER_B')] };
    expect(parseGroundedAiQualificationV1DatasetReview(manifest)).toEqual({ datasetSha256: groundedAiQualificationV1DatasetSha256(),
      attestationCount: 2, manifestClaimsApproval: true, independentlyVerified: false });
    expect(() => parseGroundedAiQualificationV1DatasetReview({ ...manifest, datasetSha256: '0'.repeat(64) })).toThrow(/dataset_review_invalid/);
    expect(() => parseGroundedAiQualificationV1DatasetReview({ ...manifest, reviewers: [reviewer('SAME'), reviewer('SAME')] }))
      .toThrow(/dataset_review_invalid/);
    expect(() => parseGroundedAiQualificationV1DatasetReview({ ...manifest, reviewers: [reviewer('ONLY_ONE')] }))
      .toThrow(/dataset_review_invalid/);
    const falseJudgment = reviewer('REVIEWER_A');
    falseJudgment.scenarioReviews[0] = { ...falseJudgment.scenarioReviews[0]!, classificationFields:
      { category: false, priority: true, recommendedTeam: true, nextAction: true } };
    expect(() => parseGroundedAiQualificationV1DatasetReview({ ...manifest, reviewers: [falseJudgment, reviewer('REVIEWER_B')] }))
      .toThrow(/dataset_review_invalid/);
    const missingCase = reviewer('REVIEWER_A');
    missingCase.scenarioReviews.pop();
    expect(() => parseGroundedAiQualificationV1DatasetReview({ ...manifest, reviewers: [missingCase, reviewer('REVIEWER_B')] }))
      .toThrow(/dataset_review_invalid/);
  });

  it('reserves a fresh report exclusively with private permissions and blocks collision, symlink, and unsafe directories', async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), 'aegis-qualification-v1-'));
    try {
      const local = join(temporaryRoot, '.local');
      const evaluations = join(local, 'evaluations');
      await mkdir(evaluations, { recursive: true, mode: 0o700 });
      await chmod(local, 0o700);
      await chmod(evaluations, 0o700);
      const destination = join(evaluations, 'qualification.json');
      const handle = await reservePrivateReport(destination);
      expect((await handle.stat()).mode & 0o777).toBe(0o600);
      await handle.writeFile('{"partial":true}\n');
      await handle.close();
      const original = await readFile(destination, 'utf8');
      await expect(reservePrivateReport(destination)).rejects.toThrow();
      expect(await readFile(destination, 'utf8')).toBe(original);

      const symlinkTarget = join(evaluations, 'target.json');
      await symlink(destination, symlinkTarget);
      await expect(reservePrivateReport(symlinkTarget)).rejects.toThrow();
      expect((await lstat(symlinkTarget)).isSymbolicLink()).toBe(true);

      const unsafeRoot = join(temporaryRoot, 'unsafe');
      const unsafeLocal = join(unsafeRoot, '.local');
      const unsafeEvaluations = join(unsafeLocal, 'evaluations');
      await mkdir(unsafeEvaluations, { recursive: true, mode: 0o755 });
      await chmod(unsafeLocal, 0o755);
      await chmod(unsafeEvaluations, 0o755);
      await expect(reservePrivateReport(join(unsafeEvaluations, 'unsafe.json'))).rejects.toThrow(/permissions are unsafe/);
    } finally { await rm(temporaryRoot, { recursive: true, force: true }); }
  });
});

describe('Grounded AI Qualification V1 deterministic mock runner', () => {
  it.each([
    ['uppercase HTTP proxy', { HTTP_PROXY: 'http://proxy.invalid' }, []],
    ['uppercase HTTPS proxy', { HTTPS_PROXY: 'http://proxy.invalid' }, []],
    ['uppercase ALL proxy', { ALL_PROXY: 'http://proxy.invalid' }, []],
    ['lowercase http proxy', { http_proxy: 'http://proxy.invalid' }, []],
    ['lowercase https proxy', { https_proxy: 'http://proxy.invalid' }, []],
    ['lowercase all proxy', { all_proxy: 'http://proxy.invalid' }, []],
    ['Node environment proxy mode', { NODE_USE_ENV_PROXY: 'yes' }, []],
    ['Node options proxy flag', { NODE_OPTIONS: '--use-env-proxy' }, []],
    ['explicit process proxy flag', {}, ['--use-env-proxy']],
    ['explicit process proxy flag with value', {}, ['--use-env-proxy=1']],
  ])('rejects %s during local transport preflight', (_name, env, execArgv) => {
    expect(() => assertQualificationV1LocalTransport(env, execArgv, contract.endpoint)).toThrow();
  });

  it('accepts proxy-free configuration only for the exact loopback generation endpoint', () => {
    expect(() => assertQualificationV1LocalTransport({}, [], contract.endpoint)).not.toThrow();
    expect(() => assertQualificationV1LocalTransport({}, [], 'https://remote.example/api/generate'))
      .toThrow(/non_loopback_endpoint/);
    expect(() => assertQualificationV1LocalTransport({}, [], 'http://localhost:11434/api/generate'))
      .toThrow(/non_loopback_endpoint/);
  });

  it('runs sequentially, passes only case facts/source DTOs, and never retries a timed-out case', async () => {
    let requests = 0;
    let active = 0;
    let maximumActive = 0;
    const run = await runGroundedBalancedEvaluation({
      healthCheck: async () => true,
      sourcesFor: (scenario) => ({ tenant: scenario.tenant, sources: scenario.sources.map((source) => ({ citationId: randomUUID(),
        title: source.title, sourceIdentity: source.sourceIdentity, version: source.version, position: 0, content: source.content })) }),
      providerFactory: (log) => ({ model: contract.model, analyze: async (input, _signal, correlationId) => {
        requests++;
        active++;
        maximumActive = Math.max(maximumActive, active);
        expect(Object.keys(input).sort()).toEqual(['caseFacts', 'caseStatus', 'caseType', 'sources']);
        log({ event: 'ai_grounded_analysis', outcome: 'failure', failureStage: 'generation_timeout',
          correlationId, latencyMs: contract.timeoutMs });
        active--;
        throw new Error('mock timeout');
      } }),
    });
    expect(requests).toBe(1);
    expect(maximumActive).toBe(1);
    expect(run.stopped).toBe(true);
    expect(run.attempts.filter((item) => item.status !== 'not_attempted')).toHaveLength(1);
    expect(run.observations.filter((item) => item.status === 'not_attempted')).toHaveLength(5);
    const result = evaluateGroundedAiQualificationV1(run.observations, {
      ...reviewEvidence, semanticReview: { independentReviewerCount: 0, complete: false, entailmentFailures: 0 },
    });
    expect(result.decision).toBe('INCONCLUSIVE');
    expect(result.requestCount).toBe(1);
    expect(result.failedCount).toBe(1);
    expect(result.notAttemptedCount).toBe(5);
  });
});

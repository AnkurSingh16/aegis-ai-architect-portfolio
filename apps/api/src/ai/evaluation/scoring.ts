import type { AnalysisResult } from '../analysis.js';
import type { ExpectedCaseLabels } from './dataset.js';

export type SanitizedAnalysisFields = Pick<AnalysisResult,
  'category' | 'priority' | 'recommendedTeam' | 'nextAction' | 'confidence' | 'uncertainty' | 'evidenceReferences' | 'humanReviewRequired'>;

export type EvaluationObservation = {
  slotId: string;
  caseType: string;
  kind: 'canonical' | 'timestamp-pair';
  expected: ExpectedCaseLabels;
  status: 'success' | 'failure' | 'not_attempted';
  result?: SanitizedAnalysisFields;
  failureStage?: string;
  schemaReason?: string;
  evidenceReason?: string;
  latencyMs?: number;
  responseBytes?: number;
  httpStatus?: number;
  promptTokens?: number | null;
  generatedTokens?: number | null;
  correlationComplete: boolean;
};

export interface CountRate { numerator: number; denominator: number; rate: number | null; state: 'measured' | 'not_measured' }
function rate(numerator: number, denominator: number): CountRate {
  return { numerator, denominator, rate: denominator === 0 ? null : Number((numerator / denominator).toFixed(4)),
    state: denominator === 0 ? 'not_measured' : 'measured' };
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : Math.round((sorted[middle - 1]! + sorted[middle]!) / 2);
}

export interface EvaluationScore {
  plannedSlots: number;
  attempted: number;
  succeeded: number;
  failed: number;
  notAttempted: number;
  metrics: {
    modelJsonParsing: CountRate & { denominatorMeaning: string };
    strictSchemaAcceptance: CountRate & { denominatorMeaning: string };
    evidenceReferenceCompliance: CountRate & { denominatorMeaning: string };
    categoryExactMatchPerAttempt: CountRate;
    priorityExactMatchPerAttempt: CountRate;
    recommendedTeamExactMatchPerAttempt: CountRate;
    nextActionExactMatchPerAttempt: CountRate;
    humanReviewEnforcement: CountRate & { denominatorMeaning: string };
    unsafeRationaleRejections: { count: number; attempts: number };
    correlationCompleteness: CountRate;
    latencyMs: { samples: number; median: number | null; p95: null; p95Reason: 'sample_too_small' };
    tokenUsage: { promptSamples: number; generatedSamples: number; promptTokens: number[]; generatedTokens: number[] };
    confidence: { meaning: 'model-reported-uncalibrated'; samples: number; values: number[] };
    uncertainty: { samples: number; counts: Record<'low' | 'moderate' | 'high', number> };
    failureStages: Record<string, number>;
    schemaReasons: Record<string, number>;
    evidenceReasons: Record<string, number>;
    authenticationAndTenantIsolation: { status: 'not_measured_by_provider_harness'; note: string };
  };
}

/** Pure scorer; provider and model output text never enter the report. */
export function scoreEvaluation(observations: readonly EvaluationObservation[]): EvaluationScore {
  const attemptedItems = observations.filter((item) => item.status !== 'not_attempted');
  const successful = attemptedItems.filter((item) => item.status === 'success' && item.result !== undefined);
  const outputsParsed = attemptedItems.filter((item) => item.status === 'success' || item.failureStage === 'output_schema');
  const evidenceChecked = attemptedItems.filter((item) => item.status === 'success' ||
    item.schemaReason === 'invalid_evidence_references');
  const humanReviewChecked = attemptedItems.filter((item) => item.status === 'success' ||
    item.schemaReason === 'invalid_human_review');
  const reasonCount = (key: 'failureStage' | 'schemaReason' | 'evidenceReason'): Record<string, number> => {
    const counts: Record<string, number> = {};
    for (const item of attemptedItems) {
      const reason = item[key];
      if (reason !== undefined) counts[reason] = (counts[reason] ?? 0) + 1;
    }
    return counts;
  };
  const match = (field: keyof ExpectedCaseLabels) => rate(successful.filter((item) => item.result?.[field] === item.expected[field]).length, attemptedItems.length);
  const promptTokens = successful.flatMap((item) => item.promptTokens === null || item.promptTokens === undefined ? [] : [item.promptTokens]);
  const generatedTokens = successful.flatMap((item) => item.generatedTokens === null || item.generatedTokens === undefined ? [] : [item.generatedTokens]);
  const latencies = attemptedItems.flatMap((item) => item.latencyMs === undefined ? [] : [item.latencyMs]);
  const uncertaintyCounts = { low: 0, moderate: 0, high: 0 };
  for (const item of successful) uncertaintyCounts[item.result!.uncertainty]++;
  const failureStages = reasonCount('failureStage');
  const modelJsonParsingDenominator = outputsParsed.length + (reasonCount('failureStage').model_json_parse ?? 0);
  const schemaAcceptanceDenominator = outputsParsed.length;
  const schemaAccepted = successful.length;
  return {
    plannedSlots: observations.length,
    attempted: attemptedItems.length,
    succeeded: successful.length,
    failed: attemptedItems.length - successful.length,
    notAttempted: observations.length - attemptedItems.length,
    metrics: {
      modelJsonParsing: { ...rate(outputsParsed.length, modelJsonParsingDenominator),
        denominatorMeaning: 'Attempts with a completed strict output parse or an explicit model_json_parse failure; earlier provider/envelope failures are excluded.' },
      strictSchemaAcceptance: { ...rate(schemaAccepted, schemaAcceptanceDenominator),
        denominatorMeaning: 'Attempts with parseable model JSON; parseable output_schema rejections are included.' },
      evidenceReferenceCompliance: { ...rate(successful.length, evidenceChecked.length),
        denominatorMeaning: 'Attempts where evidence validation completed successfully or explicitly rejected evidence references.' },
      categoryExactMatchPerAttempt: match('category'),
      priorityExactMatchPerAttempt: match('priority'),
      recommendedTeamExactMatchPerAttempt: match('recommendedTeam'),
      nextActionExactMatchPerAttempt: match('nextAction'),
      humanReviewEnforcement: { ...rate(successful.length, humanReviewChecked.length),
        denominatorMeaning: 'Attempts accepted by the validator or explicitly rejected for humanReviewRequired.' },
      unsafeRationaleRejections: { count: (reasonCount('schemaReason').unsafe_rationale ?? 0), attempts: attemptedItems.length },
      correlationCompleteness: rate(attemptedItems.filter((item) => item.correlationComplete).length, attemptedItems.length),
      latencyMs: { samples: latencies.length, median: median(latencies), p95: null, p95Reason: 'sample_too_small' },
      tokenUsage: { promptSamples: promptTokens.length, generatedSamples: generatedTokens.length, promptTokens, generatedTokens },
      confidence: { meaning: 'model-reported-uncalibrated', samples: successful.length,
        values: successful.map((item) => item.result!.confidence) },
      uncertainty: { samples: successful.length, counts: uncertaintyCounts },
      failureStages,
      schemaReasons: reasonCount('schemaReason'),
      evidenceReasons: reasonCount('evidenceReason'),
      authenticationAndTenantIsolation: { status: 'not_measured_by_provider_harness',
        note: 'Covered separately by existing Auth0 authorization and isolated PostgreSQL RLS tests; this harness bypasses the HTTP route by design.' },
    },
  };
}

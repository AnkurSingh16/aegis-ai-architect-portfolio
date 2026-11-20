/**
 * In-process metrics for durable workflow attempts. Pure: no I/O, no network. The driver records one sample per call and
 * an operator can render the counters and the duration histogram in Prometheus text format. The labels are a fixed set of
 * outcome names, so no caller-supplied text can reach a metric label.
 */

/** Outcomes the driver can report, plus the error path. */
export const ATTEMPT_OUTCOMES = ['not_claimable', 'succeeded', 'retry_scheduled', 'failed', 'lost_attempt_recovered',
  'approval_requested', 'cancelled', 'error'] as const;
export type AttemptOutcome = (typeof ATTEMPT_OUTCOMES)[number];

/** Upper bounds in seconds for the duration histogram. The last bucket is +Inf and is added at render time. */
export const DURATION_BUCKETS_SECONDS = [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10] as const;

export interface AttemptSample {
  readonly outcome: AttemptOutcome;
  readonly durationMs: number;
}

export interface WorkflowMetricsSink {
  recordAttempt(sample: AttemptSample): void;
}

export interface MetricsSnapshot {
  readonly attempts: Readonly<Record<AttemptOutcome, number>>;
  readonly durationBuckets: Readonly<Record<AttemptOutcome, readonly number[]>>;
  readonly durationSumSeconds: Readonly<Record<AttemptOutcome, number>>;
}

export interface WorkflowMetrics extends WorkflowMetricsSink {
  snapshot(): MetricsSnapshot;
}

export function createWorkflowMetrics(): WorkflowMetrics {
  const attempts = Object.fromEntries(ATTEMPT_OUTCOMES.map((o) => [o, 0])) as Record<AttemptOutcome, number>;
  const buckets = Object.fromEntries(ATTEMPT_OUTCOMES.map((o) => [o, DURATION_BUCKETS_SECONDS.map(() => 0)])) as Record<AttemptOutcome, number[]>;
  const sums = Object.fromEntries(ATTEMPT_OUTCOMES.map((o) => [o, 0])) as Record<AttemptOutcome, number>;
  return {
    recordAttempt({ outcome, durationMs }) {
      if (!(ATTEMPT_OUTCOMES as readonly string[]).includes(outcome)) throw new RangeError('unknown attempt outcome');
      if (!Number.isFinite(durationMs) || durationMs < 0) throw new RangeError('durationMs must be a finite, non-negative number');
      const seconds = durationMs / 1000;
      attempts[outcome] += 1;
      sums[outcome] += seconds;
      DURATION_BUCKETS_SECONDS.forEach((bound, index) => {
        if (seconds <= bound) buckets[outcome][index]! += 1;
      });
    },
    snapshot() {
      return {
        attempts: { ...attempts },
        durationBuckets: Object.fromEntries(ATTEMPT_OUTCOMES.map((o) => [o, [...buckets[o]]])) as Record<AttemptOutcome, number[]>,
        durationSumSeconds: { ...sums },
      };
    },
  };
}

/** Prometheus text exposition. Cumulative histogram buckets, with +Inf equal to the count. */
export function renderPrometheus(snapshot: MetricsSnapshot): string {
  const lines: string[] = [];
  lines.push('# HELP aegis_workflow_attempts_total Durable workflow driver calls by outcome.');
  lines.push('# TYPE aegis_workflow_attempts_total counter');
  for (const outcome of ATTEMPT_OUTCOMES) {
    lines.push(`aegis_workflow_attempts_total{outcome="${outcome}"} ${snapshot.attempts[outcome]}`);
  }
  lines.push('# HELP aegis_workflow_attempt_duration_seconds Durable workflow driver call duration by outcome.');
  lines.push('# TYPE aegis_workflow_attempt_duration_seconds histogram');
  for (const outcome of ATTEMPT_OUTCOMES) {
    DURATION_BUCKETS_SECONDS.forEach((bound, index) => {
      lines.push(`aegis_workflow_attempt_duration_seconds_bucket{outcome="${outcome}",le="${bound}"} ${snapshot.durationBuckets[outcome][index]}`);
    });
    lines.push(`aegis_workflow_attempt_duration_seconds_bucket{outcome="${outcome}",le="+Inf"} ${snapshot.attempts[outcome]}`);
    lines.push(`aegis_workflow_attempt_duration_seconds_sum{outcome="${outcome}"} ${snapshot.durationSumSeconds[outcome]}`);
    lines.push(`aegis_workflow_attempt_duration_seconds_count{outcome="${outcome}"} ${snapshot.attempts[outcome]}`);
  }
  return `${lines.join('\n')}\n`;
}

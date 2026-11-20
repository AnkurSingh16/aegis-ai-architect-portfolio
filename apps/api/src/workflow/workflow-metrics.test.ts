import { describe, expect, it } from 'vitest';
import { ATTEMPT_OUTCOMES, createWorkflowMetrics, DURATION_BUCKETS_SECONDS, renderPrometheus } from './workflow-metrics.js';
import { parseTraceparent } from './trace-context.js';

describe('workflow metrics', () => {
  it('counts each outcome and records the duration in every bucket it fits', () => {
    const m = createWorkflowMetrics();
    m.recordAttempt({ outcome: 'succeeded', durationMs: 40 });
    m.recordAttempt({ outcome: 'succeeded', durationMs: 3000 });
    m.recordAttempt({ outcome: 'failed', durationMs: 5 });
    const s = m.snapshot();
    expect(s.attempts.succeeded).toBe(2);
    expect(s.attempts.failed).toBe(1);
    expect(s.attempts.cancelled).toBe(0);
    // 40 ms is 0.04 s: fits the 0.05 bucket and every larger one, not the 0.01 bucket.
    const idx = (bound: number) => DURATION_BUCKETS_SECONDS.indexOf(bound as (typeof DURATION_BUCKETS_SECONDS)[number]);
    expect(s.durationBuckets.succeeded[idx(0.01)]).toBe(0);
    expect(s.durationBuckets.succeeded[idx(0.05)]).toBe(1);
    expect(s.durationBuckets.succeeded[idx(2.5)]).toBe(1);
    expect(s.durationBuckets.succeeded[idx(5)]).toBe(2);
    expect(s.durationSumSeconds.succeeded).toBeCloseTo(3.04, 6);
  });

  it('rejects an unknown outcome and an invalid duration', () => {
    const m = createWorkflowMetrics();
    expect(() => m.recordAttempt({ outcome: 'made_up' as never, durationMs: 1 })).toThrow(RangeError);
    expect(() => m.recordAttempt({ outcome: 'succeeded', durationMs: -1 })).toThrow(RangeError);
    expect(() => m.recordAttempt({ outcome: 'succeeded', durationMs: Number.NaN })).toThrow(RangeError);
  });

  it('renders Prometheus text with cumulative buckets that end at the count', () => {
    const m = createWorkflowMetrics();
    m.recordAttempt({ outcome: 'retry_scheduled', durationMs: 120 });
    const text = renderPrometheus(m.snapshot());
    expect(text).toContain('aegis_workflow_attempts_total{outcome="retry_scheduled"} 1');
    expect(text).toContain('aegis_workflow_attempt_duration_seconds_bucket{outcome="retry_scheduled",le="0.25"} 1');
    expect(text).toContain('aegis_workflow_attempt_duration_seconds_bucket{outcome="retry_scheduled",le="+Inf"} 1');
    expect(text).toContain('aegis_workflow_attempt_duration_seconds_count{outcome="retry_scheduled"} 1');
    for (const outcome of ATTEMPT_OUTCOMES) expect(text).toContain(`outcome="${outcome}"`);
  });

  it('keeps label values to the fixed outcome set', () => {
    const text = renderPrometheus(createWorkflowMetrics().snapshot());
    expect(text).not.toMatch(/outcome="[^"]*[^a-z_"][^"]*"/);
  });
});

describe('parseTraceparent', () => {
  const good = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';

  it('returns the trace id from a valid header', () => {
    expect(parseTraceparent(good)).toBe('4bf92f3577b34da6a3ce929d0e0e4736');
    expect(parseTraceparent(` ${good} `)).toBe('4bf92f3577b34da6a3ce929d0e0e4736');
  });

  it('rejects missing, malformed, uppercase, wrong-version and all-zero values', () => {
    expect(parseTraceparent(undefined)).toBeNull();
    expect(parseTraceparent('')).toBeNull();
    expect(parseTraceparent('00-4bf9-00f067aa0ba902b7-01')).toBeNull();
    expect(parseTraceparent(good.toUpperCase())).toBeNull();
    expect(parseTraceparent(good.replace(/^00/, '01'))).toBeNull();
    expect(parseTraceparent('00-00000000000000000000000000000000-00f067aa0ba902b7-01')).toBeNull();
    expect(parseTraceparent('00-4bf92f3577b34da6a3ce929d0e0e4736-0000000000000000-01')).toBeNull();
  });
});

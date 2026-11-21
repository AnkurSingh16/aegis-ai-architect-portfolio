import { describe, expect, it } from 'vitest';
import { AggregationTemporality, InMemoryMetricExporter, MeterProvider, PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { boundedReason, createExecutionTelemetry, KNOWN_REASONS } from './execution-telemetry.js';
import type { ExecutionDecision } from './execution-store.js';

// Unit tests for the P4 instruments: label bounds, and the active-execution accounting. The meter is a real SDK meter with an in-memory
// exporter, so the aggregated values are the ones an exporter would send.

function harness() {
  const exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
  const reader = new PeriodicExportingMetricReader({ exporter, exportIntervalMillis: 60_000 });
  const meterProvider = new MeterProvider({ readers: [reader] });
  spans.length = 0;
  const telemetry = createExecutionTelemetry({ meterProvider, tracerProvider: fakeTracerProvider });
  const values = async () => {
    await reader.forceFlush();
    const out = new Map<string, Array<{ attributes: Record<string, unknown>; value: number }>>();
    for (const resource of exporter.getMetrics()) {
      for (const scope of resource.scopeMetrics) {
        for (const metric of scope.metrics) {
          out.set(metric.descriptor.name, metric.dataPoints.map((p) => ({ attributes: p.attributes as Record<string, unknown>,
            value: typeof p.value === 'number' ? p.value : (p.value as { count: number }).count })));
        }
      }
    }
    return out;
  };
  return { telemetry, values, shutdown: () => meterProvider.shutdown() };
}

const spans: Array<{ name: string; attributes: Record<string, unknown> }> = [];
const fakeTracerProvider = {
  getTracer: () => ({
    startSpan: (name: string) => {
      const span = { name, attributes: {} as Record<string, unknown>,
        setAttribute(key: string, value: unknown) { span.attributes[key] = value; }, end() { spans.push({ name, attributes: span.attributes }); } };
      return span;
    },
  }),
} as unknown as import('@opentelemetry/api').TracerProvider;

const decision = (overrides: Partial<ExecutionDecision>): ExecutionDecision => ({ operation: 'claim', executionId: null, outcome: 'accepted',
  reason: null, durationMs: 2, recovered: false, terminal: false, started: false, ...overrides });

describe('P4 telemetry labels', () => {
  it('maps every reason the store can produce to itself and anything else to "other"', () => {
    for (const reason of KNOWN_REASONS) expect(boundedReason(reason)).toBe(reason);
    expect(boundedReason('user@example.com subject 12345')).toBe('other');
    expect(boundedReason(null)).toBe('none');
  });
});

describe('P4 telemetry instruments', () => {
  it('counts decisions, fencing conflicts, grant consumption and delegation refusals with bounded labels', async () => {
    const h = harness();
    h.telemetry.onDecision(decision({ operation: 'consume', outcome: 'accepted' }));
    h.telemetry.onDecision(decision({ operation: 'consume', outcome: 'refused', reason: 'grant_consumed' }));
    h.telemetry.onDecision(decision({ operation: 'delegate', outcome: 'refused', reason: 'stale_fence' }));
    h.telemetry.onDecision(decision({ operation: 'delegate', outcome: 'refused', reason: 'scope_escalation' }));
    const v = await h.values();
    expect(v.get('aegis.agent.grant.consumptions')?.map((p) => [p.attributes.outcome, p.attributes.reason, p.value]).sort())
      .toEqual([['accepted', 'none', 1], ['refused', 'grant_consumed', 1]].sort());
    expect(v.get('aegis.agent.fencing.conflicts')?.[0].value).toBe(1);
    expect(v.get('aegis.agent.delegation.refusals')?.map((p) => [p.attributes.reason, p.value]).sort())
      .toEqual([['scope_escalation', 1], ['stale_fence', 1]].sort());
    for (const point of v.get('aegis.agent.execution.decisions') ?? []) {
      expect(Object.keys(point.attributes).sort()).toEqual(['operation', 'outcome', 'reason']);
    }
    await h.shutdown();
  });

  it('keeps the active-execution count consistent: started once, terminal once, never negative', async () => {
    const h = harness();
    h.telemetry.onDecision(decision({ operation: 'claim', executionId: 'e1', started: true }));
    h.telemetry.onDecision(decision({ operation: 'claim', executionId: 'e1', started: true }));
    h.telemetry.onDecision(decision({ operation: 'claim', executionId: 'e2', started: true }));
    h.telemetry.onDecision(decision({ operation: 'release', executionId: 'e1', terminal: true }));
    h.telemetry.onDecision(decision({ operation: 'release', executionId: 'e1', terminal: true }));
    h.telemetry.onDecision(decision({ operation: 'cancel', executionId: 'never-started', terminal: true }));
    const v = await h.values();
    expect(v.get('aegis.agent.executions.active')?.[0].value).toBe(1);
    await h.shutdown();
  });

  it('counts recoveries and retry exhaustion, and reports the claim outcome', async () => {
    const h = harness();
    h.telemetry.onDecision(decision({ operation: 'claim', outcome: 'accepted', recovered: true }));
    h.telemetry.onDecision(decision({ operation: 'claim', outcome: 'refused', reason: 'retries_exhausted', terminal: true }));
    const v = await h.values();
    expect(v.get('aegis.agent.lease.recoveries')?.[0].value).toBe(1);
    expect(v.get('aegis.agent.retries.exhausted')?.[0].value).toBe(1);
    expect(v.get('aegis.agent.lease.claims')?.map((p) => [p.attributes.outcome, p.value]).sort()).toEqual([['accepted', 1], ['refused', 1]].sort());
    await h.shutdown();
  });

  it('writes one span per decision carrying the execution reference, and no content', async () => {
    const h = harness();
    h.telemetry.onDecision(decision({ operation: 'consume', executionId: '0b1f3c2e-1111-4222-8333-444455556666', outcome: 'refused',
      reason: 'not_granted' }));
    await h.values();
    expect(spans).toEqual([{ name: 'aegis.agent.execution.consume', attributes: {
      'aegis.execution.id': '0b1f3c2e-1111-4222-8333-444455556666', 'aegis.execution.outcome': 'refused', 'aegis.execution.reason': 'not_granted' } }]);
    await h.shutdown();
  });
});

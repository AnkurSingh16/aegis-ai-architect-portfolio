import { metrics, trace, type MeterProvider, type TracerProvider } from '@opentelemetry/api';
import type { ExecutionDecision } from './execution-store.js';

/**
 * OpenTelemetry instruments for P4 execution decisions. Metric labels are bounded: operation, outcome and a closed set of reasons,
 * with anything else reported as "other". Execution identifiers appear only on spans (as random UUID references), never on metrics.
 * No subject, principal value, message content, argument or grant body is recorded.
 */

export const TELEMETRY_SCOPE = 'aegis.agent-execution';

export const KNOWN_REASONS: ReadonlySet<string> = new Set([
  'not_registered', 'not_orchestrator', 'not_found', 'lease_held', 'terminal', 'retries_exhausted', 'cancel_requested',
  'cancel_not_requested', 'stale_fence', 'scope_escalation', 'cycle', 'self_delegation', 'depth_exceeded', 'discontinuous_chain',
  'unknown_agent', 'delegation_budget_exceeded', 'duplicate_delegation', 'empty_chain', 'duplicate_open_grant', 'malformed',
  'unexpected_fields', 'authority_mismatch', 'not_granted', 'grant_consumed', 'step_budget_exceeded',
]);

/** Maps a reason to the bounded label set. Unknown text never becomes a label value. */
export function boundedReason(reason: string | null): string {
  if (reason === null) return 'none';
  return KNOWN_REASONS.has(reason) ? reason : 'other';
}

export interface ExecutionTelemetry {
  onDecision(decision: ExecutionDecision): void;
}

export function createExecutionTelemetry(options: { meterProvider?: MeterProvider; tracerProvider?: TracerProvider } = {}): ExecutionTelemetry {
  const meter = (options.meterProvider ?? metrics.getMeterProvider()).getMeter(TELEMETRY_SCOPE);
  const tracer = (options.tracerProvider ?? trace.getTracerProvider()).getTracer(TELEMETRY_SCOPE);

  const decisions = meter.createCounter('aegis.agent.execution.decisions', { description: 'Execution decisions by operation, outcome and reason' });
  const claims = meter.createCounter('aegis.agent.lease.claims', { description: 'Lease claim attempts by outcome' });
  const recoveries = meter.createCounter('aegis.agent.lease.recoveries', { description: 'Claims that took over from an expired lease' });
  const fencingConflicts = meter.createCounter('aegis.agent.fencing.conflicts', { description: 'Writes refused because the fencing token is stale' });
  const grantConsumptions = meter.createCounter('aegis.agent.grant.consumptions', { description: 'Envelope authorisations by outcome and reason' });
  const delegationRefusals = meter.createCounter('aegis.agent.delegation.refusals', { description: 'Delegations refused, by reason' });
  const retriesExhausted = meter.createCounter('aegis.agent.retries.exhausted', { description: 'Executions failed after their attempt budget' });
  // Executions started by this process and not yet seen terminal. Bounded by the number of concurrently active executions.
  const activeIds = new Set<string>();
  const active = meter.createUpDownCounter('aegis.agent.executions.active', { description: 'Executions started and not yet terminal' });
  const latency = meter.createHistogram('aegis.agent.db.operation.duration', { unit: 'ms', description: 'Execution decision latency, including the database transaction' });

  return {
    onDecision(d) {
      const reason = boundedReason(d.reason);
      decisions.add(1, { operation: d.operation, outcome: d.outcome, reason });
      latency.record(d.durationMs, { operation: d.operation });
      if (d.operation === 'claim') {
        claims.add(1, { outcome: d.outcome });
        if (d.recovered) recoveries.add(1);
      }
      if (d.reason === 'stale_fence') fencingConflicts.add(1);
      if (d.operation === 'consume') grantConsumptions.add(1, { outcome: d.outcome, reason });
      if (d.operation === 'delegate' && d.outcome === 'refused') delegationRefusals.add(1, { reason });
      if (d.reason === 'retries_exhausted') retriesExhausted.add(1);
      if (d.started && d.executionId && !activeIds.has(d.executionId)) { activeIds.add(d.executionId); active.add(1); }
      if (d.terminal && d.executionId && activeIds.delete(d.executionId)) active.add(-1);

      const span = tracer.startSpan(`aegis.agent.execution.${d.operation}`, { startTime: Date.now() - d.durationMs });
      if (d.executionId) span.setAttribute('aegis.execution.id', d.executionId);
      span.setAttribute('aegis.execution.outcome', d.outcome);
      span.setAttribute('aegis.execution.reason', reason);
      span.end();
    },
  };
}

import { metrics, trace, type MeterProvider, type TracerProvider, type Attributes } from '@opentelemetry/api';

/**
 * P5 instruments. Metric labels are bounded: a closed set of outcomes and reasons, and agent identifiers (a fixed registry). Tenant,
 * execution and message identifiers, payloads, envelopes and principal references never appear on metrics. Spans carry random UUID
 * references only (message and execution identifiers), which are safe to correlate and are not authority.
 */

export const MESSAGING_SCOPE = 'aegis.messaging';

const OUTCOMES = new Set(['delivered', 'retry', 'dead', 'ack_refused', 'transport_error', 'processed', 'duplicate', 'refused', 'transient']);
const REASONS = new Set(['none', 'retry_exhausted', 'peer_unreachable', 'peer_refused', 'peer_identity_refused', 'unknown_destination',
  'bad_request', 'invalid_message', 'receiver_refused', 'stale_lease', 'lease_expired', 'in_progress', 'lease_held', 'not_granted',
  'grant_consumed', 'authority_mismatch', 'wrong_recipient', 'sender_mismatch', 'invalid_arguments', 'unknown_peer', 'malformed',
  'payload_digest_mismatch', 'arguments_digest_mismatch', 'message_mismatch', 'too_large', 'other']);

export function boundedOutcome(value: string): string { return OUTCOMES.has(value) ? value : 'other'; }
export function boundedMessageReason(value: string | null): string { return value === null ? 'none' : (REASONS.has(value) ? value : 'other'); }

export interface MessagingTelemetry {
  readonly enqueued: { add(value: number, attributes?: Attributes): void };
  deliveryDecision(outcome: string, reason: string | null, agent: string): void;
  deliveryDuration(ms: number, agent: string): void;
  attempts(count: number, agent: string): void;
  recoveries(agent: string): void;
  inboxDecision(outcome: string, reason: string | null, agent: string): void;
  duplicates(agent: string): void;
  requeues(): void;
  setBacklog(pending: number, oldestAgeSeconds: number, agent: string): void;
  span<T>(name: string, attributes: Attributes, run: (setOutcome: (outcome: string, reason?: string | null) => void) => Promise<T>): Promise<T>;
}

export function createMessagingTelemetry(options: { meterProvider?: MeterProvider; tracerProvider?: TracerProvider } = {}): MessagingTelemetry {
  const meter = (options.meterProvider ?? metrics.getMeterProvider()).getMeter(MESSAGING_SCOPE);
  const tracer = (options.tracerProvider ?? trace.getTracerProvider()).getTracer(MESSAGING_SCOPE);
  const enqueued = meter.createCounter('aegis.outbox.enqueued', { description: 'Outbound messages committed with their P4 decision' });
  const deliveries = meter.createCounter('aegis.outbox.deliveries', { description: 'Delivery attempts by outcome and reason' });
  const duration = meter.createHistogram('aegis.outbox.delivery.duration', { description: 'Delivery attempt duration', unit: 'ms' });
  const attemptHistogram = meter.createHistogram('aegis.outbox.attempts', { description: 'Attempts a message took to reach its final state' });
  const recoveries = meter.createCounter('aegis.outbox.lease.recoveries', { description: 'Messages re-leased after an expired lease' });
  const inbox = meter.createCounter('aegis.inbox.decisions', { description: 'Inbound message decisions by outcome and reason' });
  const duplicates = meter.createCounter('aegis.inbox.duplicates', { description: 'Repeated deliveries suppressed by the inbox' });
  const requeues = meter.createCounter('aegis.outbox.requeues', { description: 'Operator requeues of dead-lettered messages' });
  const backlog = new Map<string, { pending: number; oldest: number }>();
  meter.createObservableGauge('aegis.outbox.pending', { description: 'Undelivered messages by sending agent' }).addCallback((result) => {
    for (const [agent, value] of backlog) result.observe(value.pending, { agent });
  });
  meter.createObservableGauge('aegis.outbox.oldest_pending_age', { description: 'Age of the oldest undelivered message', unit: 's' })
    .addCallback((result) => {
      for (const [agent, value] of backlog) result.observe(value.oldest, { agent });
    });

  return {
    enqueued: { add: (value, attributes) => enqueued.add(value, attributes) },
    deliveryDecision: (outcome, reason, agent) => deliveries.add(1, { outcome: boundedOutcome(outcome), reason: boundedMessageReason(reason), agent }),
    deliveryDuration: (ms, agent) => duration.record(ms, { agent }),
    attempts: (count, agent) => attemptHistogram.record(count, { agent }),
    recoveries: (agent) => recoveries.add(1, { agent }),
    inboxDecision: (outcome, reason, agent) => inbox.add(1, { outcome: boundedOutcome(outcome), reason: boundedMessageReason(reason), agent }),
    duplicates: (agent) => duplicates.add(1, { agent }),
    requeues: () => requeues.add(1),
    setBacklog: (pending, oldestAgeSeconds, agent) => { backlog.set(agent, { pending, oldest: oldestAgeSeconds }); },
    span: (name, attributes, run) => tracer.startActiveSpan(name, { attributes }, async (span) => {
      try {
        return await run((outcome, reason) => {
          span.setAttribute('aegis.message.outcome', boundedOutcome(outcome));
          if (reason) span.setAttribute('aegis.message.reason', boundedMessageReason(reason));
        });
      } catch (error) {
        span.setAttribute('aegis.message.outcome', 'error');
        span.recordException(error instanceof Error ? error : new Error('error'));
        throw error;
      } finally {
        span.end();
      }
    }),
  };
}

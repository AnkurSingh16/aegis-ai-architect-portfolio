import type { ToolDispatcher, DispatchResult } from '../agents/tool-dispatcher.js';
import type { RequestContext } from '../security/tool-policy-gateway.js';
import type { createDurableStore } from './durable-store.js';
import { type DriverLog, type DriverOutcome, runDurableAttempt } from './durable-driver.js';
import type { RetryPolicy } from './retry-policy.js';

/**
 * Runs the triage tool as a durable execution. Each attempt is authorised again through the dispatcher,
 * so a stale or retried execution cannot bypass policy. Triage is read-only, so repeating an attempt is safe.
 * A denial or a handler error is a permanent failure: retrying cannot change the decision.
 */

export class PermanentToolError extends Error {
  readonly name = 'PermanentToolError';
}

export interface TriageWorkflowInput {
  readonly store: ReturnType<typeof createDurableStore>;
  readonly dispatcher: ToolDispatcher;
  readonly tenantId: string;
  readonly idempotencyKey: string;
  readonly args: Readonly<Record<string, unknown>>;
  readonly context: Omit<RequestContext, 'now'>;
  readonly owner: string;
  /** Recorded on the execution when it is created. */
  readonly correlationId?: string;
  /** Trace id from a valid traceparent header, or null. Carried on each driver log record. */
  readonly traceId?: string | null;
  /** Optional driver log. Receives one record per attempt call, with the correlation id. */
  readonly log?: DriverLog;
  readonly policy: RetryPolicy;
  readonly leaseMs: number;
  readonly timeoutMs: number;
  readonly clock: () => Date;
}

export interface TriageWorkflowResult {
  readonly executionId: string;
  readonly created: boolean;
  readonly driver: DriverOutcome;
  /** Present only when the durable attempt succeeded in this call. */
  readonly output?: unknown;
}

export async function runTriageWorkflow(input: TriageWorkflowInput): Promise<TriageWorkflowResult> {
  const { executionId, created } = await input.store.createExecution(
    input.tenantId, input.idempotencyKey, input.policy.maxAttempts, input.correlationId ?? null,
  );
  let output: unknown;
  let captured = false;

  const driver = await runDurableAttempt({
    store: input.store,
    executionId,
    tenantId: input.tenantId,
    owner: input.owner,
    policy: input.policy,
    leaseMs: input.leaseMs,
    timeoutMs: input.timeoutMs,
    clock: input.clock,
    correlationId: input.correlationId ?? null,
    traceId: input.traceId ?? null,
    ...(input.log ? { log: input.log } : {}),
    step: async () => {
      const result: DispatchResult = await input.dispatcher.dispatch(
        { toolName: 'case.triage', arguments: input.args },
        { ...input.context, now: input.clock() },
      );
      if (result.status === 'ok') {
        output = result.output;
        captured = true;
        return;
      }
      if (result.status === 'denied') throw new PermanentToolError(`denied: ${result.reasons.join(', ')}`);
      throw new PermanentToolError(result.message);
    },
  });

  return {
    executionId,
    created,
    driver,
    ...(captured && driver.status === 'succeeded' ? { output } : {}),
  };
}

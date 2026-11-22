// One P5 operation per OS process, for crash and concurrency tests. Test code only. The parent starts it with real PostgreSQL and
// kills it at a labelled point (PAUSED: stop before the commit or delivery step; COMMITTED: the step returned, nothing after it ran).
// Usage: node --import tsx messaging-child.ts '<json arguments>'
import { createDatabasePool } from '../../../storage/database.js';
import type { ExecutionHooks } from '../../persistence/execution-store.js';
import { dispatchOnce } from '../dispatcher.js';
import { receiveMessage } from '../inbox.js';
import { delegateAndDispatch, type DelegateAndDispatchInput } from '../workflow.js';
import { createMessagingTelemetry } from '../telemetry.js';

interface ChildArgs {
  readonly op: 'receive' | 'dispatch' | 'delegate';
  readonly dbUrl: string;
  readonly startAt?: number;
  readonly pauseBeforeCommit?: string;
  readonly pauseAfterCommit?: boolean;
  readonly pauseBeforeDeliver?: boolean;
  readonly pauseAfterDeliver?: boolean;
  readonly pauseBeforeAck?: boolean;
  readonly receive?: { receiver: string; peerSpiffeId: string; messageId: string; body: unknown };
  readonly dispatch?: { agentId: string; egressUrl: string; leaseSeconds: number; batchSize: number };
  readonly delegate?: DelegateAndDispatchInput;
}

const args = JSON.parse(process.argv[2] ?? '{}') as ChildArgs;
const forever = () => new Promise<never>(() => undefined);
const emit = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`);
const pool = createDatabasePool(args.dbUrl, 4);

async function main(): Promise<void> {
  if (args.startAt !== undefined) {
    const wait = args.startAt - Date.now();
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  }
  const hooks: ExecutionHooks = {
    beforeCommit: async (label) => {
      if (args.pauseBeforeCommit && label.startsWith(args.pauseBeforeCommit)) {
        emit({ event: 'PAUSED', label });
        await forever();
      }
    },
  };
  if (args.op === 'receive') {
    const result = await receiveMessage(pool, hooks, args.receive!);
    emit({ event: 'RESULT', result });
    if (args.pauseAfterCommit) { emit({ event: 'COMMITTED' }); await forever(); }
    return;
  }
  if (args.op === 'dispatch') {
    const pause = (name: string) => async () => { emit({ event: 'PAUSED', label: name }); await forever(); };
    const summary = await dispatchOnce({
      pool, agentId: args.dispatch!.agentId, instance: `child-${process.pid}`, egressUrl: args.dispatch!.egressUrl,
      leaseSeconds: args.dispatch!.leaseSeconds, batchSize: args.dispatch!.batchSize, deliveryTimeoutMs: 5000,
      telemetry: createMessagingTelemetry(),
      testHooks: {
        beforeDeliver: args.pauseBeforeDeliver ? pause('before_deliver') : undefined,
        afterDeliver: args.pauseAfterDeliver ? pause('after_deliver') : undefined,
        beforeAck: args.pauseBeforeAck ? pause('before_ack') : undefined,
      },
    });
    emit({ event: 'RESULT', summary });
    return;
  }
  const result = await delegateAndDispatch(pool, hooks, args.delegate!);
  emit({ event: 'RESULT', result });
  if (args.pauseAfterCommit) { emit({ event: 'COMMITTED' }); await forever(); }
}

main().catch((error: unknown) => {
  emit({ event: 'ERROR', message: error instanceof Error ? error.message : 'error' });
  process.exitCode = 1;
}).finally(() => {
  if (!args.pauseAfterCommit) void pool.end();
});

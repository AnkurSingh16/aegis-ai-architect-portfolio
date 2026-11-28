// One P8/P5 operation per OS process, for crash and concurrency tests. Test code only. Each process connects as one workload role, the
// same as a production runtime. The parent kills it at a labelled point: PAUSED (stopped before a commit or delivery step) or COMMITTED
// (the step returned; nothing after it ran). Usage: node --import tsx messaging-child.ts '<json arguments>'
import { createDatabasePool } from '../../../storage/database.js';
import type { ExecutionHooks } from '../../persistence/execution-store.js';
import { dispatchOnce } from '../dispatcher.js';
import { receiveMessage } from '../inbox.js';
import { startInvestigationInTx } from '../handlers.js';
import { withMessagingContext } from '../context.js';
import { createMessagingTelemetry } from '../telemetry.js';
import { reconcileCancellations } from '../cancellation.js';

interface ChildArgs {
  readonly op: 'receive' | 'dispatch' | 'intake' | 'cancel';
  readonly dbUrl: string;
  readonly startAt?: number;
  readonly pauseBeforeCommit?: string;
  readonly pauseAfterCommit?: boolean;
  readonly pauseBeforeDeliver?: boolean;
  readonly pauseAfterDeliver?: boolean;
  readonly pauseBeforeAck?: boolean;
  readonly receive?: { receiver: string; peerSpiffeId: string; messageId: string; body: unknown; orchestrator?: { spiffeId: string; instance: string } };
  readonly dispatch?: { agentId: string; egressUrl: string; leaseSeconds: number; batchSize: number };
  readonly intake?: { tenantId: string; executionId: string; spiffeId: string };
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
  if (args.op === 'cancel') {
    // One orchestrator reconciliation cycle. A pauseBeforeCommit label holds it inside an uncommitted finalisation, for a deterministic kill.
    const summary = await reconcileCancellations(pool, hooks, { instance: `child-${process.pid}`, limit: 10, lockTimeoutMs: 15000, statementTimeoutMs: 30000 });
    emit({ event: 'RESULT', summary });
    return;
  }
  if (args.op === 'intake') {
    const outcome = await withMessagingContext(pool, { tenantId: args.intake!.tenantId }, (client) => startInvestigationInTx(client, hooks, {
      tenantId: args.intake!.tenantId, executionId: args.intake!.executionId, orchestrator: { spiffeId: args.intake!.spiffeId, instance: `child-${process.pid}` } }));
    emit({ event: 'RESULT', outcome });
    if (args.pauseAfterCommit) { emit({ event: 'COMMITTED' }); await forever(); }
    return;
  }
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
}

main().catch((error: unknown) => {
  emit({ event: 'ERROR', message: error instanceof Error ? error.message : 'error' });
  process.exitCode = 1;
}).finally(() => {
  if (!args.pauseAfterCommit) void pool.end();
});

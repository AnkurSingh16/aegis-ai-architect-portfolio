// A worker process for P4 acceptance tests. It is a separate OS process with its own PostgreSQL connection, running as the runtime
// role (aegis_app). It performs exactly one store operation and prints one JSON line. Test-only hooks let the parent stop it at a
// precise point: before a commit (the transaction must roll back) or after a commit (the state must persist). The parent then
// kills the process, which is what a crashed worker looks like to the database.
//
// Usage: node --import tsx worker-child.ts '<json arguments>'
import { createDatabasePool } from '../../../storage/database.js';
import type { TenantQueryable } from '../../../security/tool-approval-store.js';
import { createAgentExecutionStore, type Fence } from '../execution-store.js';

interface ChildArgs {
  readonly op: 'claim' | 'renew' | 'release' | 'delegate' | 'grant' | 'consume' | 'cancel';
  readonly tenantId: string;
  readonly executionId: string;
  readonly spiffeId?: string;
  readonly instance?: string;
  readonly leaseSeconds?: number;
  readonly fence?: Fence;
  readonly parentSeq?: number | null;
  readonly to?: string;
  readonly requestedScopes?: string[];
  readonly chainSeq?: number;
  readonly kind?: 'request' | 'result';
  readonly action?: string;
  readonly argumentsDigest?: string;
  readonly requiredScopes?: string[];
  readonly envelope?: unknown;
  readonly nextStatus?: 'pending' | 'failed' | 'succeeded' | 'cancelled';
  readonly reason?: string;
  /** Wait until this epoch millisecond before doing the operation, so several workers start together. */
  readonly startAt?: number;
  /** Pause (print PAUSED and wait to be killed) before the first commit whose label starts with this text. */
  readonly pauseBeforeCommit?: string;
  /** Pause (print COMMITTED and wait to be killed) after the first commit whose label starts with this text. */
  readonly pauseAfterCommit?: string;
}

const args = JSON.parse(process.argv[2] ?? '{}') as ChildArgs;
const forever = () => new Promise<never>(() => undefined);
const emit = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`);

const pool = createDatabasePool(process.env.TEST_ROLE_URL_ORCHESTRATOR ?? '', 2);

async function runTenant<T>(tenantId: string, operation: (client: TenantQueryable) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('aegis.tenant_id', $1, true)", [tenantId]);
    const result = await operation(client as unknown as TenantQueryable);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

const store = createAgentExecutionStore(runTenant, {
  beforeCommit: async (label) => {
    if (args.pauseBeforeCommit && label.startsWith(args.pauseBeforeCommit)) {
      emit({ event: 'PAUSED', label });
      await forever();
    }
  },
});

async function main(): Promise<unknown> {
  if (args.startAt !== undefined) {
    const wait = args.startAt - Date.now();
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  }
  switch (args.op) {
    case 'claim':
      return store.claim({ tenantId: args.tenantId, executionId: args.executionId, spiffeId: args.spiffeId ?? '',
        instance: args.instance ?? 'worker', leaseSeconds: args.leaseSeconds ?? 30 });
    case 'renew':
      return store.renew(args.fence!, args.leaseSeconds ?? 30);
    case 'release':
      return store.release(args.fence!, args.nextStatus ?? 'pending', args.reason ?? 'released');
    case 'delegate':
      return store.recordDelegation(args.fence!, { parentSeq: args.parentSeq ?? null, to: args.to ?? '',
        requestedScopes: args.requestedScopes ?? [] });
    case 'grant':
      return store.issueGrant(args.fence!, { chainSeq: args.chainSeq ?? 1, kind: args.kind ?? 'request', action: args.action ?? '',
        argumentsDigest: args.argumentsDigest ?? '', requiredScopes: args.requiredScopes ?? [] });
    case 'consume':
      return store.consumeEnvelope(args.fence!, args.envelope);
    case 'cancel':
      return store.requestCancel(args.tenantId, args.executionId, 'operator-digest', args.reason ?? 'operator request');
    default:
      throw new Error('unknown operation');
  }
}

try {
  const result = await main();
  // The store returned, so its transaction has committed. The pause here is the crash point after a committed transition.
  if (args.pauseAfterCommit && `${args.op}:accepted`.startsWith(args.pauseAfterCommit)) {
    emit({ event: 'COMMITTED', label: `${args.op}:accepted` });
    await forever();
  }
  emit({ event: 'RESULT', result });
} catch (error) {
  emit({ event: 'ERROR', message: error instanceof Error ? error.name : 'unknown' });
  process.exitCode = 1;
} finally {
  await pool.end();
}

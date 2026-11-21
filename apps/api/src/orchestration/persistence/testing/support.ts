import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { chainDigest, argumentsDigest as digestArguments } from '../../delegation.js';
import type { DelegationChain, TypedEnvelope } from '../../types.js';

// Shared helpers for the P4 acceptance tests. Test code only: nothing here runs in the API process.

export const WORKER_CHILD = fileURLToPath(new URL('./worker-child.ts', import.meta.url));

/** A digest standing in for an authenticated principal. The tests never use a raw subject. */
export const principalRef = (label: string): string => createHash('sha256').update(`synthetic-principal:${label}`).digest('hex');

export const argsDigest = (args: Record<string, unknown>): string => digestArguments(args);

export interface WorkerExit {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly events: Array<Record<string, unknown>>;
  readonly result?: unknown;
  readonly error?: string;
}

export interface WorkerHandle {
  readonly child: ChildProcess;
  /** Resolves with the first event line whose name matches, or rejects if the process exits first. */
  waitForEvent(name: string, timeoutMs?: number): Promise<Record<string, unknown>>;
  /** Resolves when the process exits, with every event it printed. */
  exited(): Promise<WorkerExit>;
  kill(): void;
}

/** Starts one worker process. Each worker has its own PostgreSQL connection and runs as the runtime role. */
export function spawnWorker(args: Record<string, unknown>): WorkerHandle {
  const child = spawn(process.execPath, ['--import', 'tsx', WORKER_CHILD, JSON.stringify(args)], {
    env: process.env, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const events: Array<Record<string, unknown>> = [];
  const waiters: Array<{ name: string; resolve: (e: Record<string, unknown>) => void }> = [];
  let stderr = '';
  child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
  const lines = createInterface({ input: child.stdout! });
  lines.on('line', (line) => {
    let parsed: Record<string, unknown>;
    try { parsed = JSON.parse(line) as Record<string, unknown>; } catch { return; }
    events.push(parsed);
    for (const waiter of waiters.filter((w) => w.name === parsed.event)) {
      waiter.resolve(parsed);
    }
  });
  const done = new Promise<WorkerExit>((resolve) => {
    child.on('exit', (code, signal) => {
      const result = events.find((e) => e.event === 'RESULT');
      const error = events.find((e) => e.event === 'ERROR');
      resolve({ code, signal, events, result: result?.result, error: error ? String(error.message) : (code && stderr ? stderr.slice(0, 400) : undefined) });
    });
  });
  return {
    child,
    waitForEvent(name, timeoutMs = 60_000) {
      const already = events.find((e) => e.event === name);
      if (already) return Promise.resolve(already);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`timed out waiting for ${name}`)), timeoutMs);
        waiters.push({ name, resolve: (e) => { clearTimeout(timer); resolve(e); } });
        void done.then(() => { clearTimeout(timer); reject(new Error(`process exited before ${name}`)); });
      });
    },
    exited: () => done,
    kill() { child.kill('SIGKILL'); },
  };
}

/** Runs one worker to completion and returns its result. */
export async function runWorker(args: Record<string, unknown>): Promise<WorkerExit> {
  return spawnWorker(args).exited();
}

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The C8 envelope for one hop's message, built the same way a worker would build it. */
export function envelopeFor(input: {
  kind?: 'request' | 'result';
  executionId: string;
  tenantId: string;
  principal: string;
  from: string;
  to: string;
  chain: DelegationChain;
  action: string;
  args: Record<string, unknown>;
}): TypedEnvelope {
  return {
    kind: input.kind ?? 'request',
    executionId: input.executionId,
    tenantId: input.tenantId,
    principalRef: input.principal,
    from: input.from,
    to: input.to,
    depth: input.chain.length,
    chainDigest: chainDigest(input.chain),
    action: input.action,
    argumentsDigest: digestArguments(input.args),
  };
}

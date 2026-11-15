import { describe, expect, it, vi } from 'vitest';
import { installGracefulShutdown } from './server-lifecycle.js';

type Signal = 'SIGINT' | 'SIGTERM';
function signalProcess() {
  const handlers = new Map<Signal, () => void>();
  return {
    processLike: { exitCode: 0, on: vi.fn((signal: Signal, handler: () => void) => { handlers.set(signal, handler); }) },
    emit: (signal: Signal) => handlers.get(signal)?.(),
  };
}

describe('API process lifecycle', () => {
  it('closes the Fastify app once when interrupted by SIGINT or SIGTERM', async () => {
    const close = vi.fn().mockResolvedValue(undefined);
    const fake = signalProcess();
    const shutdown = installGracefulShutdown({ close }, fake.processLike);

    fake.emit('SIGTERM');
    fake.emit('SIGINT');
    await shutdown();

    expect(fake.processLike.on.mock.calls.map(([signal]) => signal)).toEqual(['SIGINT', 'SIGTERM']);
    expect(close).toHaveBeenCalledTimes(1);
    expect(fake.processLike.exitCode).toBe(0);
  });

  it('marks shutdown failure without exposing the underlying error', async () => {
    const close = vi.fn().mockRejectedValue(new Error('SECRET_DATABASE_URL'));
    const fake = signalProcess();
    const logError = vi.fn();
    const shutdown = installGracefulShutdown({ close }, fake.processLike, logError);

    fake.emit('SIGTERM');
    fake.emit('SIGTERM');
    await shutdown();

    expect(close).toHaveBeenCalledTimes(1);
    expect(fake.processLike.exitCode).toBe(1);
    expect(logError).toHaveBeenCalledTimes(1);
    expect(logError.mock.calls).toEqual([[]]);
  });
});

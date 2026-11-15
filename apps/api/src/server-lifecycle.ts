type ShutdownSignal = 'SIGINT' | 'SIGTERM';

type CloseableApp = { close: () => Promise<unknown> };
type SignalProcess = { on: (signal: ShutdownSignal, listener: () => void) => unknown; exitCode?: string | number | null };

/** Owns the API process shutdown path; Fastify's onClose hook closes its database pool. */
export function installGracefulShutdown(app: CloseableApp, processLike: SignalProcess = process,
  logError: () => void = () => console.error(JSON.stringify({ event: 'api.shutdown_failed' }))): () => Promise<void> {
  let shutdown: Promise<void> | undefined;
  const closeOnce = (): Promise<void> => {
    if (!shutdown) {
      shutdown = app.close().then(() => undefined).catch(() => {
        processLike.exitCode = 1;
        logError();
      });
    }
    return shutdown;
  };

  const handleSignal = (): void => { void closeOnce(); };
  for (const signal of ['SIGINT', 'SIGTERM'] satisfies ShutdownSignal[]) processLike.on(signal, handleSignal);
  return closeOnce;
}

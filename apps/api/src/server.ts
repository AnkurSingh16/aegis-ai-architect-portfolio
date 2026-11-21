import { isIP } from 'node:net';
import { createApp } from './app.js';
import { installGracefulShutdown } from './server-lifecycle.js';

try {
  const app = createApp();
  installGracefulShutdown(app);
  const port = Number(process.env.PORT ?? 4000);
  // Loopback unless the deployment says otherwise. A container sets AEGIS_API_HOST=0.0.0.0 inside its own network namespace, and the
  // host port is published on 127.0.0.1 only. The value must be an IP literal, so a name cannot change what is exposed.
  const host = process.env.AEGIS_API_HOST ?? '127.0.0.1';
  if (!isIP(host)) throw new Error('Invalid listen address.');
  try {
  await app.listen({ port, host });
  console.info(`Aegis API listening on http://localhost:${port}`);
  } catch {
    await app.close();
    throw new Error('Startup failed.');
  }
} catch {
  console.error(JSON.stringify({ event: 'api.startup_failed', message: 'Check local server, authentication and database configuration.' }));
  process.exitCode = 1;
}

import { createApp } from './app.js';

try {
  const app = createApp();
  const port = Number(process.env.PORT ?? 4000);
  try {
  await app.listen({ port, host: '127.0.0.1' });
  console.info(`Aegis API listening on http://localhost:${port}`);
  } catch {
    await app.close();
    throw new Error('Startup failed.');
  }
} catch {
  console.error(JSON.stringify({ event: 'api.startup_failed', message: 'Check local server, authentication and database configuration.' }));
  process.exitCode = 1;
}

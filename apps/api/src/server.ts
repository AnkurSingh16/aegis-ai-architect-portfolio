import { createApp } from './app.js';

const app = createApp();
const port = Number(process.env.PORT ?? 4000);

try {
  await app.listen({ port, host: '127.0.0.1' });
  console.info(`Aegis API listening on http://localhost:${port}`);
} catch (error) {
  app.log.error(error);
  process.exitCode = 1;
}

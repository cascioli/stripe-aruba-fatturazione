import { buildApp } from './app.js';
import { env } from './config/env.js';
import { startWorker } from './worker/queue.js';

async function main() {
  const app = await buildApp();

  startWorker();

  await app.listen({ port: env.PORT, host: '0.0.0.0' });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

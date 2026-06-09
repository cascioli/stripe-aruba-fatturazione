import { env } from './config/env.js';

async function main() {
  const { default: Fastify } = await import('fastify');
  const app = Fastify({ logger: true });

  await app.listen({ port: env.PORT, host: '0.0.0.0' });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

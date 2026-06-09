import Fastify, { type FastifyInstance } from 'fastify';
import rawBodyPlugin from 'fastify-raw-body';
import { webhookRoutes } from './routes/webhook.js';

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: process.env.NODE_ENV !== 'test',
  });

  // Scoped plugin: rawBody only captured for the webhook route
  await app.register(async (scope) => {
    await scope.register(rawBodyPlugin, {
      field: 'rawBody',
      global: true,
      encoding: false, // Buffer — required for Stripe HMAC verification
      runFirst: true,
    });
    await scope.register(webhookRoutes);
  });

  return app;
}

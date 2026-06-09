import type { FastifyPluginAsync } from 'fastify';
import Stripe from 'stripe';
import { prisma } from '../db/prisma.js';
import { env } from '../config/env.js';
import type { EventType } from '../domain/types.js';
import { enqueue } from '../worker/queue.js';

// Augment FastifyRequest with rawBody added by fastify-raw-body
declare module 'fastify' {
  interface FastifyRequest {
    rawBody: Buffer | string | null;
  }
}

const HANDLED_EVENTS = new Set<string>(['invoice.paid', 'charge.refunded', 'invoice.voided']);

const stripe = new Stripe(env.STRIPE_SECRET_KEY);

export const webhookRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.post('/webhook', async (request, reply) => {
    const sig = request.headers['stripe-signature'];
    if (!sig || typeof sig !== 'string') {
      return reply.status(400).send({ error: 'Missing Stripe-Signature' });
    }

    let event: Stripe.Event;
    try {
      event = stripe.webhooks.constructEvent(
        request.rawBody as Buffer,
        sig,
        env.STRIPE_WEBHOOK_SECRET,
      );
    } catch {
      fastify.log.warn('Webhook signature verification failed');
      return reply.status(400).send({ error: 'Invalid signature' });
    }

    if (!HANDLED_EVENTS.has(event.type)) {
      fastify.log.info({ eventType: event.type, eventId: event.id }, 'Ignoring unhandled event type');
      return reply.status(200).send({ received: true });
    }

    const obj = event.data.object as Record<string, unknown>;
    // For charge.refunded the invoice ref is on obj.invoice; for invoice.* it's obj.id
    const stripeInvoiceId =
      event.type === 'charge.refunded'
        ? ((obj.invoice as string | null | undefined) ?? null)
        : ((obj.id as string | null | undefined) ?? null);

    try {
      const job = await prisma.fatturaJob.create({
        data: {
          stripeEventId: event.id,
          stripeInvoiceId,
          eventType: event.type as EventType,
          rawPayload: JSON.stringify(event),
          status: 'PENDING',
        },
      });
      enqueue(job.id);
    } catch (err: unknown) {
      if (isEventIdDuplicate(err)) {
        fastify.log.info({ eventId: event.id }, 'Evento già ricevuto — idempotenza OK');
        return reply.status(200).send({ received: true });
      }
      throw err;
    }

    return reply.status(200).send({ received: true });
  });
};

function isEventIdDuplicate(err: unknown): boolean {
  if (
    typeof err !== 'object' ||
    err === null ||
    !('code' in err) ||
    (err as { code: string }).code !== 'P2002'
  ) return false;
  const meta = (err as { meta?: { target?: string[] } }).meta;
  return Array.isArray(meta?.target) && meta.target.includes('stripeEventId');
}

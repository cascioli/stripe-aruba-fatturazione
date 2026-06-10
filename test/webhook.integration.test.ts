import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { execSync } from 'node:child_process';
import Stripe from 'stripe';
import type { FastifyInstance } from 'fastify';
import { PrismaClient } from '@prisma/client';
import { invoicePaidEvent } from './fixtures/invoice-paid.js';

vi.mock('../src/worker/queue.js', () => ({
  enqueue: vi.fn(),
}));

const testPrisma = new PrismaClient();
const TEST_SECRET = process.env.STRIPE_WEBHOOK_SECRET!;
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);

function makeSignedRequest(payload: string) {
  const sig = stripe.webhooks.generateTestHeaderString({ payload, secret: TEST_SECRET });
  return { payload, sig };
}

describe('POST /webhook (integration – real SQLite)', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    execSync('npx prisma db push --skip-generate', {
      stdio: 'pipe',
      env: { ...process.env },
    });
    const { buildApp } = await import('../src/app.js');
    app = await buildApp();
  });

  afterAll(async () => {
    await app.close();
    await testPrisma.$disconnect();
  });

  beforeEach(async () => {
    await testPrisma.fatturaJob.deleteMany();
  });

  it('valid signature + invoice.paid → one row persisted', async () => {
    const payload = JSON.stringify(invoicePaidEvent);
    const { sig } = makeSignedRequest(payload);

    const res = await app.inject({
      method: 'POST',
      url: '/webhook',
      headers: { 'stripe-signature': sig, 'content-type': 'application/json' },
      payload,
    });

    expect(res.statusCode).toBe(200);
    expect(await testPrisma.fatturaJob.count()).toBe(1);
    const job = await testPrisma.fatturaJob.findFirst();
    expect(job?.stripeEventId).toBe(invoicePaidEvent.id);
    expect(job?.eventType).toBe('invoice.paid');
    expect(job?.status).toBe('PENDING');
    // Fiscal document key is derived from invoice ID
    expect(job?.fiscalDocumentKey).toBe(`${invoicePaidEvent.data.object.id}:TD01`);
  });

  it('invalid signature → no row persisted', async () => {
    const payload = JSON.stringify(invoicePaidEvent);

    const res = await app.inject({
      method: 'POST',
      url: '/webhook',
      headers: { 'stripe-signature': 't=1,v1=badhash', 'content-type': 'application/json' },
      payload,
    });

    expect(res.statusCode).toBe(400);
    expect(await testPrisma.fatturaJob.count()).toBe(0);
  });

  it('missing signature header → no row persisted', async () => {
    const payload = JSON.stringify(invoicePaidEvent);

    const res = await app.inject({
      method: 'POST',
      url: '/webhook',
      headers: { 'content-type': 'application/json' },
      payload,
    });

    expect(res.statusCode).toBe(400);
    expect(await testPrisma.fatturaJob.count()).toBe(0);
  });

  it('ignored event type → no row persisted', async () => {
    const unhandled = { ...invoicePaidEvent, id: 'evt_customer_001', type: 'customer.created' };
    const payload = JSON.stringify(unhandled);
    const { sig } = makeSignedRequest(payload);

    const res = await app.inject({
      method: 'POST',
      url: '/webhook',
      headers: { 'stripe-signature': sig, 'content-type': 'application/json' },
      payload,
    });

    expect(res.statusCode).toBe(200);
    expect(await testPrisma.fatturaJob.count()).toBe(0);
  });

  it('duplicate evt_... delivery → second 200 but only one row in DB', async () => {
    const payload = JSON.stringify(invoicePaidEvent);

    const { sig: sig1 } = makeSignedRequest(payload);
    await app.inject({
      method: 'POST',
      url: '/webhook',
      headers: { 'stripe-signature': sig1, 'content-type': 'application/json' },
      payload,
    });

    const { sig: sig2 } = makeSignedRequest(payload);
    const second = await app.inject({
      method: 'POST',
      url: '/webhook',
      headers: { 'stripe-signature': sig2, 'content-type': 'application/json' },
      payload,
    });

    expect(second.statusCode).toBe(200);
    expect(await testPrisma.fatturaJob.count()).toBe(1);
  });

  it('two different invoice.paid events for same invoice → second ignored via fiscalDocumentKey', async () => {
    // First event — creates job with fiscalDocumentKey = "<invoiceId>:TD01"
    const payload1 = JSON.stringify(invoicePaidEvent);
    const { sig: sig1 } = makeSignedRequest(payload1);
    const first = await app.inject({
      method: 'POST',
      url: '/webhook',
      headers: { 'stripe-signature': sig1, 'content-type': 'application/json' },
      payload: payload1,
    });
    expect(first.statusCode).toBe(200);
    expect(await testPrisma.fatturaJob.count()).toBe(1);

    // Second event — different Stripe event ID, same invoice ID → same fiscalDocumentKey → P2002
    const secondEvent = { ...invoicePaidEvent, id: 'evt_test_invoice_paid_duplicate_002' };
    const payload2 = JSON.stringify(secondEvent);
    const { sig: sig2 } = makeSignedRequest(payload2);
    const second = await app.inject({
      method: 'POST',
      url: '/webhook',
      headers: { 'stripe-signature': sig2, 'content-type': 'application/json' },
      payload: payload2,
    });

    // Idempotent 200, no second job created
    expect(second.statusCode).toBe(200);
    expect(await testPrisma.fatturaJob.count()).toBe(1);
  });

  it('livemode=true event with ARUBA_ENV=DEMO → 200 but no job created', async () => {
    // ARUBA_ENV=DEMO (set in test/setup.ts) expects livemode=false; live events are ignored
    const livemodeEvent = { ...invoicePaidEvent, id: 'evt_live_mismatch_001', livemode: true };
    const payload = JSON.stringify(livemodeEvent);
    const { sig } = makeSignedRequest(payload);

    const res = await app.inject({
      method: 'POST',
      url: '/webhook',
      headers: { 'stripe-signature': sig, 'content-type': 'application/json' },
      payload,
    });

    expect(res.statusCode).toBe(200);
    expect(await testPrisma.fatturaJob.count()).toBe(0);
  });

  it('invoice.paid then invoice.voided for same invoice → two rows in DB', async () => {
    const paidPayload = JSON.stringify(invoicePaidEvent);
    const { sig: sig1 } = makeSignedRequest(paidPayload);
    const first = await app.inject({
      method: 'POST',
      url: '/webhook',
      headers: { 'stripe-signature': sig1, 'content-type': 'application/json' },
      payload: paidPayload,
    });
    expect(first.statusCode).toBe(200);

    const voidedEvent = {
      ...invoicePaidEvent,
      id: 'evt_test_invoice_voided_001',
      type: 'invoice.voided' as const,
    };
    const voidedPayload = JSON.stringify(voidedEvent);
    const { sig: sig2 } = makeSignedRequest(voidedPayload);
    const second = await app.inject({
      method: 'POST',
      url: '/webhook',
      headers: { 'stripe-signature': sig2, 'content-type': 'application/json' },
      payload: voidedPayload,
    });

    expect(second.statusCode).toBe(200);
    expect(await testPrisma.fatturaJob.count()).toBe(2);
  });

  it('invoice.paid then charge.refunded for same invoice → two rows in DB', async () => {
    const paidPayload = JSON.stringify(invoicePaidEvent);
    const { sig: sig1 } = makeSignedRequest(paidPayload);
    await app.inject({
      method: 'POST',
      url: '/webhook',
      headers: { 'stripe-signature': sig1, 'content-type': 'application/json' },
      payload: paidPayload,
    });

    const chargeRefundedEvent = {
      id: 'evt_test_charge_refunded_001',
      object: 'event' as const,
      api_version: '2024-06-20',
      created: 1700000100,
      livemode: false,
      pending_webhooks: 1,
      request: { id: null, idempotency_key: null },
      type: 'charge.refunded' as const,
      data: {
        object: {
          id: 'ch_test_001',
          object: 'charge' as const,
          invoice: 'in_test_invoice_001',
          refunds: {
            data: [{ id: 're_test_001', amount: 12200 }],
          },
        },
      },
    };
    const refundedPayload = JSON.stringify(chargeRefundedEvent);
    const { sig: sig2 } = makeSignedRequest(refundedPayload);
    const second = await app.inject({
      method: 'POST',
      url: '/webhook',
      headers: { 'stripe-signature': sig2, 'content-type': 'application/json' },
      payload: refundedPayload,
    });

    expect(second.statusCode).toBe(200);
    expect(await testPrisma.fatturaJob.count()).toBe(2);
    const jobs = await testPrisma.fatturaJob.findMany({ orderBy: { createdAt: 'asc' } });
    expect(jobs[0].eventType).toBe('invoice.paid');
    expect(jobs[1].eventType).toBe('charge.refunded');
    expect(jobs[1].stripeInvoiceId).toBe('in_test_invoice_001');
    expect(jobs[1].stripeRefundId).toBe('re_test_001');
    expect(jobs[1].fiscalDocumentKey).toBe('in_test_invoice_001:TD04:re_test_001');
  });
});

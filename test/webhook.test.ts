import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import Stripe from 'stripe';
import type { FastifyInstance } from 'fastify';
import { invoicePaidEvent } from './fixtures/invoice-paid.js';

const { mockEnqueue } = vi.hoisted(() => ({ mockEnqueue: vi.fn() }));

// --- module mocks (hoisted before imports by vitest) ---

const mockCreate = vi.fn();

vi.mock('../src/db/prisma.js', () => ({
  prisma: {
    fatturaJob: {
      create: mockCreate,
    },
  },
}));

vi.mock('../src/worker/queue.js', () => ({
  enqueue: mockEnqueue,
}));

// --- test helpers ---

const TEST_SECRET = process.env.STRIPE_WEBHOOK_SECRET!;
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);

function makeSignedRequest(payload: string) {
  const sig = stripe.webhooks.generateTestHeaderString({
    payload,
    secret: TEST_SECRET,
  });
  return { payload, sig };
}

// --- suite ---

describe('POST /webhook', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    const { buildApp } = await import('../src/app.js');
    app = await buildApp();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('valid signature + invoice.paid → 200 and row inserted', async () => {
    const payload = JSON.stringify(invoicePaidEvent);
    const { sig } = makeSignedRequest(payload);

    mockCreate.mockResolvedValueOnce({ id: 'job_cuid_001' });

    const res = await app.inject({
      method: 'POST',
      url: '/webhook',
      headers: { 'stripe-signature': sig, 'content-type': 'application/json' },
      payload,
    });

    expect(res.statusCode).toBe(200);
    expect(mockCreate).toHaveBeenCalledOnce();
    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          stripeEventId: invoicePaidEvent.id,
          stripeInvoiceId: 'in_test_invoice_001',
          eventType: 'invoice.paid',
          status: 'PENDING',
        }),
      }),
    );
  });

  it('invalid signature → 400 and no row inserted', async () => {
    const payload = JSON.stringify(invoicePaidEvent);

    const res = await app.inject({
      method: 'POST',
      url: '/webhook',
      headers: { 'stripe-signature': 't=1,v1=badhash', 'content-type': 'application/json' },
      payload,
    });

    expect(res.statusCode).toBe(400);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('missing Stripe-Signature header → 400 and no row inserted', async () => {
    const payload = JSON.stringify(invoicePaidEvent);

    const res = await app.inject({
      method: 'POST',
      url: '/webhook',
      headers: { 'content-type': 'application/json' },
      payload,
    });

    expect(res.statusCode).toBe(400);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('unhandled event type (customer.created) → 200 ignored, no row inserted', async () => {
    const unhandledEvent = { ...invoicePaidEvent, id: 'evt_customer_001', type: 'customer.created' };
    const payload = JSON.stringify(unhandledEvent);
    const { sig } = makeSignedRequest(payload);

    const res = await app.inject({
      method: 'POST',
      url: '/webhook',
      headers: { 'stripe-signature': sig, 'content-type': 'application/json' },
      payload,
    });

    expect(res.statusCode).toBe(200);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('invoice.voided after invoice.paid on same invoice → creates new job row', async () => {
    const invoiceVoidedEvent = {
      ...invoicePaidEvent,
      id: 'evt_test_invoice_voided_001',
      type: 'invoice.voided' as const,
    };
    const payload = JSON.stringify(invoiceVoidedEvent);
    const { sig } = makeSignedRequest(payload);

    mockCreate.mockResolvedValueOnce({ id: 'job_cuid_002' });

    const res = await app.inject({
      method: 'POST',
      url: '/webhook',
      headers: { 'stripe-signature': sig, 'content-type': 'application/json' },
      payload,
    });

    expect(res.statusCode).toBe(200);
    expect(mockCreate).toHaveBeenCalledOnce();
    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          stripeEventId: 'evt_test_invoice_voided_001',
          stripeInvoiceId: 'in_test_invoice_001',
          eventType: 'invoice.voided',
        }),
      }),
    );
  });

  it('charge.refunded after invoice.paid on same invoice → creates PENDING job row with refundId', async () => {
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
          amount_refunded: 12200,
          refunds: { data: [{ id: 're_test_001', amount: 12200 }] },
        },
        previous_attributes: { amount_refunded: 0 },
      },
    };
    const payload = JSON.stringify(chargeRefundedEvent);
    const { sig } = makeSignedRequest(payload);

    mockCreate.mockResolvedValueOnce({ id: 'job_cuid_003' });

    const res = await app.inject({
      method: 'POST',
      url: '/webhook',
      headers: { 'stripe-signature': sig, 'content-type': 'application/json' },
      payload,
    });

    expect(res.statusCode).toBe(200);
    expect(mockCreate).toHaveBeenCalledOnce();
    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          stripeEventId: 'evt_test_charge_refunded_001',
          stripeInvoiceId: 'in_test_invoice_001',
          stripeRefundId: 're_test_001',
          eventType: 'charge.refunded',
          status: 'PENDING',
        }),
      }),
    );
    expect(mockEnqueue).toHaveBeenCalledOnce();
  });

  it('charge.refunded with multiple refunds — triggering refund identified by delta, not data[0]', async () => {
    // data[0] has amount 5000 (a previous refund), data[1] has amount 7200 (the triggering one).
    // previous_attributes shows previous total was 5000, so delta = 7200.
    const chargeRefundedEvent = {
      id: 'evt_test_charge_refunded_multi_001',
      object: 'event' as const,
      api_version: '2024-06-20',
      created: 1700000200,
      livemode: false,
      pending_webhooks: 1,
      request: { id: null, idempotency_key: null },
      type: 'charge.refunded' as const,
      data: {
        object: {
          id: 'ch_test_002',
          object: 'charge' as const,
          invoice: 'in_test_invoice_001',
          amount_refunded: 12200,
          refunds: {
            data: [
              { id: 're_test_second', amount: 7200 },
              { id: 're_test_first', amount: 5000 },
            ],
          },
        },
        previous_attributes: { amount_refunded: 5000 },
      },
    };
    const payload = JSON.stringify(chargeRefundedEvent);
    const { sig } = makeSignedRequest(payload);
    mockCreate.mockResolvedValueOnce({ id: 'job_cuid_multi' });

    const res = await app.inject({
      method: 'POST',
      url: '/webhook',
      headers: { 'stripe-signature': sig, 'content-type': 'application/json' },
      payload,
    });

    expect(res.statusCode).toBe(200);
    expect(mockCreate).toHaveBeenCalledOnce();
    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          stripeRefundId: 're_test_second',
          status: 'PENDING',
        }),
      }),
    );
    expect(mockEnqueue).toHaveBeenCalledOnce();
  });

  it('charge.refunded with ambiguous refunds — job created as FAILED_VALIDATION with lastError, enqueued for worker alert+sync', async () => {
    // Two refunds with the same amount: delta matches both — indeterminate.
    const chargeRefundedEvent = {
      id: 'evt_test_charge_refunded_ambig_001',
      object: 'event' as const,
      api_version: '2024-06-20',
      created: 1700000300,
      livemode: false,
      pending_webhooks: 1,
      request: { id: null, idempotency_key: null },
      type: 'charge.refunded' as const,
      data: {
        object: {
          id: 'ch_test_003',
          object: 'charge' as const,
          invoice: 'in_test_invoice_001',
          amount_refunded: 10000,
          refunds: {
            data: [
              { id: 're_test_b', amount: 5000 },
              { id: 're_test_a', amount: 5000 },
            ],
          },
        },
        previous_attributes: { amount_refunded: 5000 },
      },
    };
    const payload = JSON.stringify(chargeRefundedEvent);
    const { sig } = makeSignedRequest(payload);
    mockCreate.mockResolvedValueOnce({ id: 'job_cuid_ambig' });

    const res = await app.inject({
      method: 'POST',
      url: '/webhook',
      headers: { 'stripe-signature': sig, 'content-type': 'application/json' },
      payload,
    });

    expect(res.statusCode).toBe(200);
    expect(mockCreate).toHaveBeenCalledOnce();
    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          stripeRefundId: null,
          status: 'FAILED_VALIDATION',
          lastError: 'Unable to identify triggering Stripe refund deterministically',
          metadataSyncStatus: 'PENDING',
        }),
      }),
    );
    // Worker must be informed so it can send the alert + write metadata back to Stripe.
    expect(mockEnqueue).toHaveBeenCalledOnce();
    expect(mockEnqueue).toHaveBeenCalledWith('job_cuid_ambig');
  });

  it('charge.refunded: single refund amount mismatches delta from previous_attributes → FAILED_VALIDATION', async () => {
    // 1 refund in list but its amount (5000) ≠ delta (8000 - 5000 = 3000) → cannot confirm identity.
    const chargeRefundedEvent = {
      id: 'evt_test_charge_refunded_mismatch_001',
      object: 'event' as const,
      api_version: '2024-06-20',
      created: 1700000400,
      livemode: false,
      pending_webhooks: 1,
      request: { id: null, idempotency_key: null },
      type: 'charge.refunded' as const,
      data: {
        object: {
          id: 'ch_test_004',
          object: 'charge' as const,
          invoice: 'in_test_invoice_001',
          amount_refunded: 8000,
          refunds: { data: [{ id: 're_test_mismatch', amount: 5000 }] },
        },
        previous_attributes: { amount_refunded: 5000 },
      },
    };
    const payload = JSON.stringify(chargeRefundedEvent);
    const { sig } = makeSignedRequest(payload);
    mockCreate.mockResolvedValueOnce({ id: 'job_cuid_mismatch' });

    const res = await app.inject({
      method: 'POST',
      url: '/webhook',
      headers: { 'stripe-signature': sig, 'content-type': 'application/json' },
      payload,
    });

    expect(res.statusCode).toBe(200);
    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          stripeRefundId: null,
          status: 'FAILED_VALIDATION',
          lastError: 'Unable to identify triggering Stripe refund deterministically',
        }),
      }),
    );
    expect(mockEnqueue).toHaveBeenCalledOnce();
  });

  it('P2002 on non-stripeEventId target re-throws → 500', async () => {
    const payload = JSON.stringify(invoicePaidEvent);
    const { sig } = makeSignedRequest(payload);

    const otherConflict = Object.assign(new Error('Unique constraint on unknown field'), {
      code: 'P2002',
      meta: { target: ['someOtherField'] },
    });
    mockCreate.mockRejectedValueOnce(otherConflict);

    const res = await app.inject({
      method: 'POST',
      url: '/webhook',
      headers: { 'stripe-signature': sig, 'content-type': 'application/json' },
      payload,
    });

    expect(res.statusCode).toBe(500);
  });

  it('duplicate event (same evt_... id) → second request 200, no second row created', async () => {
    const payload = JSON.stringify(invoicePaidEvent);
    const { sig } = makeSignedRequest(payload);

    // First call succeeds
    mockCreate.mockResolvedValueOnce({ id: 'job_cuid_001' });

    const first = await app.inject({
      method: 'POST',
      url: '/webhook',
      headers: { 'stripe-signature': sig, 'content-type': 'application/json' },
      payload,
    });
    expect(first.statusCode).toBe(200);

    // Second call: DB throws P2002 unique constraint violation on stripeEventId
    const uniqueError = Object.assign(new Error('Unique constraint'), {
      code: 'P2002',
      meta: { target: ['stripeEventId'] },
    });
    mockCreate.mockRejectedValueOnce(uniqueError);

    // Regenerate valid sig (timestamp must be fresh)
    const { sig: sig2 } = makeSignedRequest(payload);

    const second = await app.inject({
      method: 'POST',
      url: '/webhook',
      headers: { 'stripe-signature': sig2, 'content-type': 'application/json' },
      payload,
    });

    expect(second.statusCode).toBe(200);
    // create was called twice total but the second threw P2002 → idempotent response
    expect(mockCreate).toHaveBeenCalledTimes(2);
  });
});

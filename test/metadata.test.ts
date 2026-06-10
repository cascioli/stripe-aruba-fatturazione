import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { updateStripeMetadata } from '../src/stripe/metadata.js';

const STRIPE_BASE = 'https://api.stripe.com';

const server = setupServer();

beforeAll(() => server.listen({ onUnhandledRequest: 'bypass' }));
afterAll(() => server.close());
afterEach(() => server.resetHandlers());

describe('updateStripeMetadata (MSW contract)', () => {
  it('success with arubaInvoiceId: POST sends aruba_status and aruba_invoice_id', async () => {
    let capturedBody: Record<string, string> | null = null;

    server.use(
      http.post(`${STRIPE_BASE}/v1/invoices/:invoiceId`, async ({ request }) => {
        const text = await request.text();
        capturedBody = Object.fromEntries(new URLSearchParams(text));
        return HttpResponse.json({ id: 'in_test_001', object: 'invoice' });
      }),
    );

    await updateStripeMetadata('in_test_001', 'aruba-inv-001', 'SENT_SDI');

    expect(capturedBody).not.toBeNull();
    expect(capturedBody!['metadata[aruba_status]']).toBe('SENT_SDI');
    expect(capturedBody!['metadata[aruba_invoice_id]']).toBe('aruba-inv-001');
  });

  it('success without arubaInvoiceId: POST sends only aruba_status, no aruba_invoice_id', async () => {
    let capturedBody: Record<string, string> | null = null;

    server.use(
      http.post(`${STRIPE_BASE}/v1/invoices/:invoiceId`, async ({ request }) => {
        const text = await request.text();
        capturedBody = Object.fromEntries(new URLSearchParams(text));
        return HttpResponse.json({ id: 'in_test_001', object: 'invoice' });
      }),
    );

    await updateStripeMetadata('in_test_001', null, 'FAILED_VALIDATION');

    expect(capturedBody).not.toBeNull();
    expect(capturedBody!['metadata[aruba_status]']).toBe('FAILED_VALIDATION');
    expect(capturedBody!['metadata[aruba_invoice_id]']).toBeUndefined();
  });

  it('failure status writes correct aruba_status', async () => {
    let capturedBody: Record<string, string> | null = null;

    server.use(
      http.post(`${STRIPE_BASE}/v1/invoices/:invoiceId`, async ({ request }) => {
        const text = await request.text();
        capturedBody = Object.fromEntries(new URLSearchParams(text));
        return HttpResponse.json({ id: 'in_test_002', object: 'invoice' });
      }),
    );

    await updateStripeMetadata('in_test_002', null, 'ERROR');

    expect(capturedBody!['metadata[aruba_status]']).toBe('ERROR');
    expect(capturedBody!['metadata[aruba_invoice_id]']).toBeUndefined();
  });

  it('Stripe API error propagates as rejection', async () => {
    server.use(
      http.post(`${STRIPE_BASE}/v1/invoices/:invoiceId`, () =>
        HttpResponse.json({ error: { type: 'invalid_request_error', message: 'No such invoice' } }, { status: 404 }),
      ),
    );

    await expect(
      updateStripeMetadata('in_not_found', null, 'ERROR'),
    ).rejects.toThrow();
  });
});

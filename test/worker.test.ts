import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { processJob } from '../src/worker/processor.js';
import { enqueue, queue, stopWorker } from '../src/worker/queue.js';
import { RETRY_DELAYS_MS } from '../src/worker/processor.js';
import {
  DEMO_BASE,
  demoSigninHandler,
  demoUploadSuccessHandler,
  demoUpload503Handler,
  validTokenResponse,
} from './mocks/aruba.handlers.js';

// --- module mocks (hoisted so vi.mock factories can reference them) ---

const {
  mockFindUnique,
  mockFindMany,
  mockUpdate,
  mockCreate,
  mockSendAlert,
  mockUpdateStripeMetadata,
} = vi.hoisted(() => ({
  mockFindUnique: vi.fn(),
  mockFindMany: vi.fn(),
  mockUpdate: vi.fn(),
  mockCreate: vi.fn(),
  mockSendAlert: vi.fn(),
  mockUpdateStripeMetadata: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../src/db/prisma.js', () => ({
  prisma: {
    fatturaJob: {
      findUnique: mockFindUnique,
      findMany: mockFindMany,
      update: mockUpdate,
      create: mockCreate,
    },
  },
}));

vi.mock('../src/notifications/alerter.js', () => ({
  sendAlert: mockSendAlert,
}));

// Mock stripe/metadata.ts — processor calls this as a side-effect; we verify args directly.
// MSW-level coverage for updateStripeMetadata itself lives in test/metadata.test.ts.
vi.mock('../src/stripe/metadata.js', () => ({
  updateStripeMetadata: mockUpdateStripeMetadata,
}));

// --- constants ---

const STRIPE_BASE = 'https://api.stripe.com';

// --- fixtures ---

// Valid Italian VAT 12345678903: check digit verified
const VALID_FISCAL_META = {
  vat_number: '12345678903',
  sdi_code: 'XXXXXXX',
  denominazione: 'ACME Srl',
  indirizzo: 'Via Roma 1',
  cap: '00100',
  comune: 'Roma',
  provincia: 'RM',
  nazione: 'IT',
};

// Realistic webhook payload: customer is a string ID, tax_rate is an unexpanded string ID.
// Stripe API (MSW-intercepted) provides expanded data when processor retrieves the invoice.
function makeRawEvent(overrides: {
  id?: string;
  type?: string;
  total?: number;
  lineAmount?: number;
  taxAmount?: number;
}) {
  const {
    id = 'evt_test_001',
    type = 'invoice.paid',
    total = 12200,
    lineAmount = 10000,
    taxAmount = 2200,
  } = overrides;

  return JSON.stringify({
    id,
    type,
    data: {
      object: {
        id: 'in_test_001',
        number: 'INV-0001',
        created: 1700000000,
        currency: 'eur',
        total,
        customer: 'cus_test_001',
        lines: {
          data: [
            {
              amount: lineAmount,
              description: 'Servizio SaaS',
              quantity: 1,
              tax_amounts:
                taxAmount > 0
                  ? [{ amount: taxAmount, tax_rate: 'txr_001' }]
                  : [],
            },
          ],
        },
      },
    },
  });
}

// Default Stripe invoice retrieve response (expanded customer + tax rate)
const stripeExpandedInvoice = {
  id: 'in_test_001',
  object: 'invoice',
  number: 'INV-0001',
  created: 1700000000,
  currency: 'eur',
  total: 12200,
  customer: { id: 'cus_test_001', object: 'customer', metadata: VALID_FISCAL_META },
  lines: {
    object: 'list',
    data: [
      {
        id: 'il_001',
        object: 'line_item',
        amount: 10000,
        description: 'Servizio SaaS',
        quantity: 1,
        tax_amounts: [
          { amount: 2200, tax_rate: { id: 'txr_001', object: 'tax_rate', percentage: 22, metadata: {} } },
        ],
      },
    ],
  },
  metadata: {},
};

// Stripe invoice retrieve handler — returns expanded invoice with valid fiscal metadata
const stripeInvoiceRetrieveHandler = http.get(
  `${STRIPE_BASE}/v1/invoices/:invoiceId`,
  () => HttpResponse.json(stripeExpandedInvoice),
);

// --- MSW server ---

const server = setupServer(demoSigninHandler, demoUploadSuccessHandler, stripeInvoiceRetrieveHandler);

beforeAll(() => server.listen({ onUnhandledRequest: 'bypass' }));
afterAll(() => server.close());
afterEach(() => {
  server.resetHandlers();
  vi.clearAllMocks();
  stopWorker();
});

const pendingValidJob = {
  id: 'job_001',
  stripeEventId: 'evt_test_001',
  stripeInvoiceId: 'in_test_001',
  eventType: 'invoice.paid',
  status: 'PENDING',
  arubaInvoiceId: null,
  retryCount: 0,
  nextRetryAt: null,
  lastError: null,
  rawPayload: makeRawEvent({}),
};

const sentSdiJob = {
  ...pendingValidJob,
  id: 'job_002',
  status: 'SENT_SDI',
  arubaInvoiceId: 'aruba-inv-already',
};

// Invalid job has same raw payload structure; Stripe MSW handler is overridden per-test
// to return empty customer metadata, causing validateFiscalData to fail.
const pendingInvalidJob = {
  ...pendingValidJob,
  id: 'job_003',
};

// --- tests ---

describe('processJob: idempotency', () => {
  it('SENT_SDI job skips Aruba — no upload call, no DB write', async () => {
    mockFindUnique.mockResolvedValue(sentSdiJob);

    let arubaCalled = false;
    server.use(
      http.post(`${DEMO_BASE}/services/invoice/out/uploadFile`, () => {
        arubaCalled = true;
        return HttpResponse.json({ arubaInvoiceId: 'aruba-inv-new' });
      }),
    );

    await processJob(sentSdiJob.id);

    expect(arubaCalled).toBe(false);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('job with arubaInvoiceId already set skips processing', async () => {
    mockFindUnique.mockResolvedValue({
      ...pendingValidJob,
      status: 'CREATED_DRAFT',
      arubaInvoiceId: 'aruba-inv-existing',
    });

    await processJob('job_001');

    expect(mockUpdate).not.toHaveBeenCalled();
  });
});

describe('processJob: success path', () => {
  it('valid data + Aruba 200 → CREATED_DRAFT, arubaInvoiceId saved, Stripe metadata updated', async () => {
    mockFindUnique.mockResolvedValue(pendingValidJob);
    mockUpdate.mockResolvedValue({});

    await processJob('job_001');

    expect(mockUpdate).toHaveBeenCalledOnce();
    expect(mockUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'CREATED_DRAFT',
          arubaInvoiceId: 'aruba-inv-001',
          lastError: null,
        }),
      }),
    );

    expect(mockUpdateStripeMetadata).toHaveBeenCalledOnce();
    expect(mockUpdateStripeMetadata).toHaveBeenCalledWith('in_test_001', 'aruba-inv-001', 'CREATED_DRAFT');

    expect(mockSendAlert).not.toHaveBeenCalled();
  });
});

describe('processJob: validation failure', () => {
  it('invalid fiscal data → FAILED_VALIDATION, no Aruba call, alert sent, Stripe metadata updated', async () => {
    mockFindUnique.mockResolvedValue(pendingInvalidJob);
    mockUpdate.mockResolvedValue({});

    // Override Stripe response: empty customer metadata → validateFiscalData fails
    server.use(
      http.get(`${STRIPE_BASE}/v1/invoices/:invoiceId`, () =>
        HttpResponse.json({
          ...stripeExpandedInvoice,
          customer: { id: 'cus_test_001', object: 'customer', metadata: {} },
        }),
      ),
    );

    let arubaCalled = false;
    server.use(
      http.post(`${DEMO_BASE}/services/invoice/out/uploadFile`, () => {
        arubaCalled = true;
        return HttpResponse.json({ arubaInvoiceId: 'aruba-inv-001' });
      }),
    );

    await processJob('job_003');

    expect(arubaCalled).toBe(false);

    expect(mockUpdate).toHaveBeenCalledOnce();
    expect(mockUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'FAILED_VALIDATION' }),
      }),
    );

    expect(mockSendAlert).toHaveBeenCalledOnce();
    const alertPayload = mockSendAlert.mock.calls[0][0] as {
      reason: string;
      errors: string[];
    };
    expect(alertPayload.reason).toContain('validation');
    expect(alertPayload.errors.length).toBeGreaterThan(0);

    expect(mockUpdateStripeMetadata).toHaveBeenCalledOnce();
    expect(mockUpdateStripeMetadata).toHaveBeenCalledWith('in_test_001', null, 'FAILED_VALIDATION');
  });
});

describe('processJob: retry on 5xx', () => {
  it('Aruba 503 → retryCount incremented, nextRetryAt = now+60s, job stays PENDING', async () => {
    mockFindUnique.mockResolvedValue(pendingValidJob);
    mockUpdate.mockResolvedValue({});

    server.use(demoUpload503Handler);

    const before = Date.now();
    await processJob('job_001');
    const after = Date.now();

    expect(mockUpdate).toHaveBeenCalledOnce();
    const updateCall = mockUpdate.mock.calls[0][0] as {
      data: { retryCount: number; nextRetryAt: Date; lastError: string };
    };

    expect(updateCall.data.retryCount).toBe(1);
    expect(updateCall.data.nextRetryAt).toBeInstanceOf(Date);

    const retryMs = updateCall.data.nextRetryAt.getTime();
    expect(retryMs - before).toBeGreaterThanOrEqual(RETRY_DELAYS_MS[0]);
    expect(retryMs - after).toBeLessThanOrEqual(RETRY_DELAYS_MS[0] + 500);

    expect(mockSendAlert).not.toHaveBeenCalled();
    expect(mockUpdateStripeMetadata).not.toHaveBeenCalled();
  });

  it('second retry uses 5m delay (retryCount=1 → retryCount=2)', async () => {
    mockFindUnique.mockResolvedValue({ ...pendingValidJob, retryCount: 1 });
    mockUpdate.mockResolvedValue({});

    server.use(demoUpload503Handler);

    const before = Date.now();
    await processJob('job_001');

    const updateCall = mockUpdate.mock.calls[0][0] as {
      data: { retryCount: number; nextRetryAt: Date };
    };

    expect(updateCall.data.retryCount).toBe(2);
    const retryMs = updateCall.data.nextRetryAt.getTime();
    expect(retryMs - before).toBeGreaterThanOrEqual(RETRY_DELAYS_MS[1]);
  });
});

describe('processJob: single Aruba attempt per invocation (Comment 3)', () => {
  it('Aruba 503 → exactly one upload request per processJob call', async () => {
    mockFindUnique.mockResolvedValue(pendingValidJob);
    mockUpdate.mockResolvedValue({});

    let uploadCount = 0;
    server.use(
      http.post(`${DEMO_BASE}/services/invoice/out/uploadFile`, () => {
        uploadCount++;
        return new HttpResponse(null, { status: 503 });
      }),
    );

    await processJob('job_001');

    expect(uploadCount).toBe(1);
  });
});

describe('processJob: nextRetryAt eligibility guard (Comment 2)', () => {
  it('job with future nextRetryAt skips Aruba without any DB write', async () => {
    const futureRetryAt = new Date(Date.now() + 60_000);
    mockFindUnique.mockResolvedValue({ ...pendingValidJob, nextRetryAt: futureRetryAt });

    let uploadCount = 0;
    server.use(
      http.post(`${DEMO_BASE}/services/invoice/out/uploadFile`, () => {
        uploadCount++;
        return HttpResponse.json({ arubaInvoiceId: 'aruba-inv-001' });
      }),
    );

    await processJob('job_001');

    expect(uploadCount).toBe(0);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('duplicate queued after 503 does not call Aruba before nextRetryAt expires', async () => {
    const futureRetryAt = new Date(Date.now() + 60_000);

    // First call: PENDING, no nextRetryAt → calls Aruba, gets 503, schedules retry
    mockFindUnique
      .mockResolvedValueOnce(pendingValidJob)
      .mockResolvedValueOnce({ ...pendingValidJob, nextRetryAt: futureRetryAt });
    mockUpdate.mockResolvedValue({});

    let uploadCount = 0;
    server.use(
      http.post(`${DEMO_BASE}/services/invoice/out/uploadFile`, () => {
        uploadCount++;
        return new HttpResponse(null, { status: 503 });
      }),
    );

    await processJob('job_001');
    expect(uploadCount).toBe(1);

    // Second call (duplicate) — DB now shows future nextRetryAt → must skip
    await processJob('job_001');
    expect(uploadCount).toBe(1);
  });
});

describe('processJob: Stripe metadata writeback on Aruba 4xx failure', () => {
  it('Aruba 400 → ERROR/FAILED_VALIDATION status, alert, Stripe metadata updated', async () => {
    mockFindUnique.mockResolvedValue(pendingValidJob);
    mockUpdate.mockResolvedValue({});

    server.use(
      http.post(`${DEMO_BASE}/auth/signin`, () => HttpResponse.json(validTokenResponse)),
      http.post(`${DEMO_BASE}/services/invoice/out/uploadFile`, () =>
        HttpResponse.json({ error: 'Bad data' }, { status: 400 }),
      ),
    );

    await processJob('job_001');

    expect(mockUpdate).toHaveBeenCalledOnce();
    const updateData = (mockUpdate.mock.calls[0][0] as { data: { status: string } }).data;
    expect(updateData.status).toBe('FAILED_VALIDATION');

    expect(mockSendAlert).toHaveBeenCalledOnce();

    expect(mockUpdateStripeMetadata).toHaveBeenCalledOnce();
    expect(mockUpdateStripeMetadata).toHaveBeenCalledWith('in_test_001', null, 'FAILED_VALIDATION');
  });
});

describe('enqueue: async decoupling', () => {
  it('enqueue returns synchronously before Aruba is called (webhook can ACK first)', async () => {
    mockFindUnique.mockResolvedValue(pendingValidJob);
    mockUpdate.mockResolvedValue({});

    let arubaCalled = false;
    server.use(
      http.post(`${DEMO_BASE}/auth/signin`, () => HttpResponse.json(validTokenResponse)),
      http.post(`${DEMO_BASE}/services/invoice/out/uploadFile`, async () => {
        arubaCalled = true;
        return HttpResponse.json({ arubaInvoiceId: 'aruba-inv-001' });
      }),
    );

    let enqueueReturned = false;
    enqueue('job_001');
    enqueueReturned = true;

    expect(enqueueReturned).toBe(true);
    expect(arubaCalled).toBe(false);

    await queue.onIdle();
    expect(arubaCalled).toBe(true);
  });
});

describe('enqueue: deduplication (Comment 2)', () => {
  it('duplicate enqueue while job in-flight is ignored — only one upload call', async () => {
    mockFindUnique.mockResolvedValue(pendingValidJob);
    mockUpdate.mockResolvedValue({});

    let uploadCount = 0;
    server.use(
      http.post(`${DEMO_BASE}/services/invoice/out/uploadFile`, () => {
        uploadCount++;
        return HttpResponse.json({ arubaInvoiceId: 'aruba-inv-001' });
      }),
    );

    // Both enqueues happen before any async work runs
    enqueue('job_001');
    enqueue('job_001'); // duplicate — inFlightJobs guard should drop this

    await queue.onIdle();

    expect(uploadCount).toBe(1);
  });
});

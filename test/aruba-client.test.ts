import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { setupServer } from 'msw/node';
import { delay, http, HttpResponse } from 'msw';
import { ArubaClient } from '../src/aruba/client.js';
import { ArubaTokenManager } from '../src/aruba/auth.js';
import type { CedenteConfig } from '../src/aruba/payload-builder.js';
import type { FiscalInvoice } from '../src/domain/types.js';
import {
  DEMO_BASE,
  PROD_BASE,
  validTokenResponse,
  demoSigninHandler,
  demoUploadSuccessHandler,
  demoUploadAndSendSuccessHandler,
  demoUpload400Handler,
  demoUpload503Handler,
  demoUploadNetworkErrorHandler,
} from './mocks/aruba.handlers.js';

// --- fixtures ---

const testCedente: CedenteConfig = {
  partitaIva: '09876543210',
  denominazione: 'Test Company Srl',
  indirizzo: 'Via Milano 10',
  cap: '20100',
  comune: 'Milano',
  provincia: 'MI',
  nazione: 'IT',
  regimeFiscale: 'RF01',
};

const testInvoice: FiscalInvoice = {
  stripeInvoiceId: 'in_test_001',
  stripeEventId: 'evt_test_001',
  tipoDocumento: 'TD01',
  number: 'INV0001',
  date: new Date('2024-01-15'),
  currency: 'EUR',
  customer: {
    vatNumber: '01234567890',
    denominazione: 'Cliente Srl',
    indirizzo: 'Via Roma 1',
    cap: '00100',
    comune: 'Roma',
    provincia: 'RM',
    nazione: 'IT',
  },
  lineItems: [
    {
      description: 'Servizio SaaS',
      quantity: 1,
      unitPrice: 100,
      vatRate: 22,
      natura: null,
      taxableAmount: 100,
      vatAmount: 22,
    },
  ],
  totals: { taxable: 100, vat: 22, grand: 122 },
};

const testCreditNote: FiscalInvoice = {
  ...testInvoice,
  tipoDocumento: 'TD04',
  number: 'NC0001',
};

// --- server setup ---

const server = setupServer(
  demoSigninHandler,
  demoUploadSuccessHandler,
  demoUploadAndSendSuccessHandler,
);

beforeAll(() => server.listen({ onUnhandledRequest: 'warn' }));
afterAll(() => server.close());
afterEach(() => server.resetHandlers());

function makeClient(
  sendMode: 'DRAFT' | 'DIRECT' = 'DRAFT',
  baseUrl: string = DEMO_BASE,
): ArubaClient {
  const tokenManager = new ArubaTokenManager(baseUrl, 'user@test.it', 'secret');
  return new ArubaClient(tokenManager, testCedente, sendMode, {
    maxAttempts: 3,
    baseDelayMs: 0,
    maxDelayMs: 0,
  }, baseUrl);
}

describe('ArubaClient.uploadInvoice', () => {
  it('returns ok:true with arubaInvoiceId on success', async () => {
    const client = makeClient();
    const result = await client.uploadInvoice(testInvoice);

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.arubaInvoiceId).toBe('aruba-inv-001');
  });

  it('DRAFT mode posts to uploadFile endpoint', async () => {
    let capturedPath: string | undefined;
    server.use(
      http.post(`${DEMO_BASE}/services/invoice/out/uploadFile`, ({ request }) => {
        capturedPath = new URL(request.url).pathname;
        return HttpResponse.json({ arubaInvoiceId: 'aruba-inv-001' });
      }),
    );

    const client = makeClient('DRAFT');
    await client.uploadInvoice(testInvoice);

    expect(capturedPath).toBe('/services/invoice/out/uploadFile');
  });

  it('DIRECT mode posts to uploadAndSendFile endpoint', async () => {
    let capturedPath: string | undefined;
    server.use(
      http.post(`${DEMO_BASE}/services/invoice/out/uploadAndSendFile`, ({ request }) => {
        capturedPath = new URL(request.url).pathname;
        return HttpResponse.json({ arubaInvoiceId: 'aruba-inv-001' });
      }),
    );

    const client = makeClient('DIRECT');
    await client.uploadInvoice(testInvoice);

    expect(capturedPath).toBe('/services/invoice/out/uploadAndSendFile');
  });

  it('DRAFT mode sends upload envelope with dataFile, credential, domain, no commit', async () => {
    let capturedBody: Record<string, unknown> = {};
    server.use(
      http.post(`${DEMO_BASE}/services/invoice/out/uploadFile`, async ({ request }) => {
        capturedBody = await request.json() as Record<string, unknown>;
        return HttpResponse.json({ arubaInvoiceId: 'aruba-inv-001' });
      }),
    );

    const client = makeClient('DRAFT');
    await client.uploadInvoice(testInvoice);

    expect(typeof capturedBody.dataFile).toBe('string');
    const decoded = Buffer.from(capturedBody.dataFile as string, 'base64').toString('utf-8');
    expect(decoded).toContain('<FatturaElettronica');
    expect('credential' in capturedBody).toBe(true);
    expect('domain' in capturedBody).toBe(true);
    expect('commit' in capturedBody).toBe(false);
  });

  it('DIRECT mode sends upload envelope to uploadAndSendFile', async () => {
    let capturedBody: Record<string, unknown> = {};
    server.use(
      http.post(`${DEMO_BASE}/services/invoice/out/uploadAndSendFile`, async ({ request }) => {
        capturedBody = await request.json() as Record<string, unknown>;
        return HttpResponse.json({ arubaInvoiceId: 'aruba-inv-001' });
      }),
    );

    const client = makeClient('DIRECT');
    await client.uploadInvoice(testInvoice);

    expect(typeof capturedBody.dataFile).toBe('string');
    const decoded = Buffer.from(capturedBody.dataFile as string, 'base64').toString('utf-8');
    expect(decoded).toContain('<FatturaElettronica');
    expect('credential' in capturedBody).toBe(true);
    expect('domain' in capturedBody).toBe(true);
    expect('commit' in capturedBody).toBe(false);
  });

  it('credit note (TD04) carries TipoDocumento:TD04 in FatturaPA XML', async () => {
    let capturedXml: string | undefined;
    server.use(
      http.post(`${DEMO_BASE}/services/invoice/out/uploadFile`, async ({ request }) => {
        const body = await request.json() as { dataFile: string; credential: string; domain: string };
        capturedXml = Buffer.from(body.dataFile, 'base64').toString('utf-8');
        return HttpResponse.json({ arubaInvoiceId: 'aruba-inv-001' });
      }),
    );

    const client = makeClient();
    await client.uploadInvoice(testCreditNote);

    expect(capturedXml).toContain('<TipoDocumento>TD04</TipoDocumento>');
  });

  it('success response missing arubaInvoiceId returns ok:false, retryable:false', async () => {
    server.use(
      http.post(`${DEMO_BASE}/services/invoice/out/uploadFile`, () =>
        HttpResponse.json({}),
      ),
    );

    const client = makeClient();
    const result = await client.uploadInvoice(testInvoice);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.retryable).toBe(false);
    }
  });

  it('4xx returns ok:false, retryable:false, no retry', async () => {
    server.use(demoUpload400Handler);

    let uploadCallCount = 0;
    server.use(
      http.post(`${DEMO_BASE}/services/invoice/out/uploadFile`, () => {
        uploadCallCount++;
        return HttpResponse.json({ error: 'VALIDATION_ERROR' }, { status: 400 });
      }),
    );

    const client = makeClient();
    const result = await client.uploadInvoice(testInvoice);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.retryable).toBe(false);
      expect(result.status).toBe(400);
    }
    expect(uploadCallCount).toBe(1);
  });

  it('5xx triggers retry up to maxAttempts times', async () => {
    let callCount = 0;
    server.use(
      http.post(`${DEMO_BASE}/services/invoice/out/uploadFile`, () => {
        callCount++;
        return new HttpResponse(null, { status: 503 });
      }),
    );

    const client = makeClient();
    const result = await client.uploadInvoice(testInvoice);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.retryable).toBe(true);
    expect(callCount).toBe(3); // maxAttempts=3
  });

  it('5xx then success: succeeds after transient failures', async () => {
    let callCount = 0;
    server.use(
      http.post(`${DEMO_BASE}/services/invoice/out/uploadFile`, () => {
        callCount++;
        if (callCount < 3) return new HttpResponse(null, { status: 503 });
        return HttpResponse.json({ arubaInvoiceId: 'aruba-inv-001' });
      }),
    );

    const client = makeClient();
    const result = await client.uploadInvoice(testInvoice);

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.arubaInvoiceId).toBe('aruba-inv-001');
    expect(callCount).toBe(3);
  });

  it('network error returns ok:false, retryable:true, status:undefined', async () => {
    server.use(demoUploadNetworkErrorHandler);

    const client = makeClient();
    const result = await client.uploadInvoice(testInvoice);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.retryable).toBe(true);
      expect(result.status).toBeUndefined();
    }
  });

  it('4xx never retries (single call only)', async () => {
    let callCount = 0;
    server.use(
      http.post(`${DEMO_BASE}/services/invoice/out/uploadFile`, () => {
        callCount++;
        return new HttpResponse('unprocessable', { status: 422 });
      }),
    );

    const client = makeClient();
    const result = await client.uploadInvoice(testInvoice);

    expect(result.ok).toBe(false);
    expect(callCount).toBe(1);
  });

  it('Authorization header carries Bearer token from tokenManager', async () => {
    let capturedAuth: string | undefined;
    server.use(
      http.post(`${DEMO_BASE}/services/invoice/out/uploadFile`, ({ request }) => {
        capturedAuth = request.headers.get('Authorization') ?? undefined;
        return HttpResponse.json({ arubaInvoiceId: 'aruba-inv-001' });
      }),
    );

    const client = makeClient();
    await client.uploadInvoice(testInvoice);

    expect(capturedAuth).toBe(`Bearer ${validTokenResponse.access_token}`);
  });

  it('PROD client: both auth and upload hit PROD base URL', async () => {
    let prodSigninCount = 0;
    let prodUploadCount = 0;
    server.use(
      http.post(`${PROD_BASE}/auth/signin`, () => {
        prodSigninCount++;
        return HttpResponse.json({ ...validTokenResponse, access_token: 'prod-token' });
      }),
      http.post(`${PROD_BASE}/services/invoice/out/uploadFile`, () => {
        prodUploadCount++;
        return HttpResponse.json({ arubaInvoiceId: 'aruba-inv-prod-001' });
      }),
    );

    const client = makeClient('DRAFT', PROD_BASE);
    const result = await client.uploadInvoice(testInvoice);

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.arubaInvoiceId).toBe('aruba-inv-prod-001');
    expect(prodSigninCount).toBe(1);
    expect(prodUploadCount).toBe(1);
  });

  it('auth 503 returns ok:false, retryable:true', async () => {
    server.use(
      http.post(`${DEMO_BASE}/auth/signin`, () =>
        new HttpResponse(null, { status: 503 }),
      ),
    );

    const client = makeClient();
    const result = await client.uploadInvoice(testInvoice);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.retryable).toBe(true);
    }
  });

  it('auth 503 is retried up to maxAttempts', async () => {
    let signinCount = 0;
    server.use(
      http.post(`${DEMO_BASE}/auth/signin`, () => {
        signinCount++;
        return new HttpResponse(null, { status: 503 });
      }),
    );

    const client = makeClient();
    await client.uploadInvoice(testInvoice);

    expect(signinCount).toBe(3); // maxAttempts=3
  });

  it('auth network error returns ok:false, retryable:true', async () => {
    server.use(
      http.post(`${DEMO_BASE}/auth/signin`, () => HttpResponse.error()),
    );

    const client = makeClient();
    const result = await client.uploadInvoice(testInvoice);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.retryable).toBe(true);
      expect(result.status).toBeUndefined();
    }
  });

  it('auth 401 returns ok:false, retryable:false, status:401, not retried', async () => {
    let signinCount = 0;
    server.use(
      http.post(`${DEMO_BASE}/auth/signin`, () => {
        signinCount++;
        return new HttpResponse(null, { status: 401 });
      }),
    );

    const client = makeClient();
    const result = await client.uploadInvoice(testInvoice);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.retryable).toBe(false);
      expect(result.status).toBe(401);
    }
    expect(signinCount).toBe(1);
  });

  it('auth 400 returns ok:false, retryable:false, status:400, not retried', async () => {
    let signinCount = 0;
    server.use(
      http.post(`${DEMO_BASE}/auth/signin`, () => {
        signinCount++;
        return new HttpResponse(null, { status: 400 });
      }),
    );

    const client = makeClient();
    const result = await client.uploadInvoice(testInvoice);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.retryable).toBe(false);
      expect(result.status).toBe(400);
    }
    expect(signinCount).toBe(1);
  });

  it('upload timeout returns ok:false, retryable:true', async () => {
    server.use(
      http.post(`${DEMO_BASE}/services/invoice/out/uploadFile`, async () => {
        await delay(500);
        return HttpResponse.json({ arubaInvoiceId: 'aruba-inv-001' });
      }),
    );

    const tokenManager = new ArubaTokenManager(DEMO_BASE, 'user@test.it', 'secret');
    const client = new ArubaClient(
      tokenManager,
      testCedente,
      'DRAFT',
      { maxAttempts: 1 },
      DEMO_BASE,
      50, // 50ms timeout — fires before the 500ms delay
    );
    const result = await client.uploadInvoice(testInvoice);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.retryable).toBe(true);
      expect(result.status).toBeUndefined();
    }
  }, 3000);
});

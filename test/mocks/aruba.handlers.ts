import { http, HttpResponse } from 'msw';

export const DEMO_BASE = 'https://demows.fatturazioneelettronica.aruba.it';
export const PROD_BASE = 'https://ws.fatturazioneelettronica.aruba.it';
export const DEMO_AUTH_BASE = 'https://demoauth.fatturazioneelettronica.aruba.it';
export const PROD_AUTH_BASE = 'https://auth.fatturazioneelettronica.aruba.it';

export const validTokenResponse = {
  access_token: 'test-access-token',
  expires_in: 3600,
  refresh_token: 'test-refresh-token',
  token_type: 'Bearer',
};

function validateEnvelope(body: Record<string, unknown>): boolean {
  return typeof body.dataFile === 'string' && 'credential' in body && 'domain' in body;
}

export const demoSigninHandler = http.post(`${DEMO_BASE}/auth/signin`, () =>
  HttpResponse.json(validTokenResponse),
);

export const demoAuthSigninHandler = http.post(`${DEMO_AUTH_BASE}/auth/signin`, () =>
  HttpResponse.json(validTokenResponse),
);

export const prodSigninHandler = http.post(`${PROD_BASE}/auth/signin`, () =>
  HttpResponse.json({ ...validTokenResponse, access_token: 'prod-access-token' }),
);

export const prodAuthSigninHandler = http.post(`${PROD_AUTH_BASE}/auth/signin`, () =>
  HttpResponse.json({ ...validTokenResponse, access_token: 'prod-access-token' }),
);

export const demoSignin503Handler = http.post(
  `${DEMO_BASE}/auth/signin`,
  () => new HttpResponse(null, { status: 503 }),
);

export const demoSigninNetworkErrorHandler = http.post(
  `${DEMO_BASE}/auth/signin`,
  () => HttpResponse.error(),
);

export const demoUploadSuccessHandler = http.post(
  `${DEMO_BASE}/services/invoice/out/uploadFile`,
  async ({ request }) => {
    const body = await request.json() as Record<string, unknown>;
    if (!validateEnvelope(body)) {
      return new HttpResponse('Invalid upload envelope: missing dataFile, credential, or domain', { status: 400 });
    }
    return HttpResponse.json({ arubaInvoiceId: 'aruba-inv-001' });
  },
);

export const demoUploadAndSendSuccessHandler = http.post(
  `${DEMO_BASE}/services/invoice/out/uploadAndSendFile`,
  async ({ request }) => {
    const body = await request.json() as Record<string, unknown>;
    if (!validateEnvelope(body)) {
      return new HttpResponse('Invalid upload envelope: missing dataFile, credential, or domain', { status: 400 });
    }
    return HttpResponse.json({ arubaInvoiceId: 'aruba-inv-001' });
  },
);

export const prodUploadSuccessHandler = http.post(
  `${PROD_BASE}/services/invoice/out/uploadFile`,
  async ({ request }) => {
    const body = await request.json() as Record<string, unknown>;
    if (!validateEnvelope(body)) {
      return new HttpResponse('Invalid upload envelope: missing dataFile, credential, or domain', { status: 400 });
    }
    return HttpResponse.json({ arubaInvoiceId: 'aruba-inv-prod-001' });
  },
);

export const prodUploadAndSendSuccessHandler = http.post(
  `${PROD_BASE}/services/invoice/out/uploadAndSendFile`,
  async ({ request }) => {
    const body = await request.json() as Record<string, unknown>;
    if (!validateEnvelope(body)) {
      return new HttpResponse('Invalid upload envelope: missing dataFile, credential, or domain', { status: 400 });
    }
    return HttpResponse.json({ arubaInvoiceId: 'aruba-inv-prod-001' });
  },
);

export const demoUpload400Handler = http.post(
  `${DEMO_BASE}/services/invoice/out/uploadFile`,
  () =>
    HttpResponse.json(
      { error: 'VALIDATION_ERROR', message: 'Invalid fiscal code' },
      { status: 400 },
    ),
);

export const demoUpload503Handler = http.post(
  `${DEMO_BASE}/services/invoice/out/uploadFile`,
  () => new HttpResponse(null, { status: 503, statusText: 'Service Unavailable' }),
);

export const demoUploadNetworkErrorHandler = http.post(
  `${DEMO_BASE}/services/invoice/out/uploadFile`,
  () => HttpResponse.error(),
);

export const defaultArubaHandlers = [
  demoSigninHandler,
  demoAuthSigninHandler,
  prodSigninHandler,
  prodAuthSigninHandler,
  demoUploadSuccessHandler,
  demoUploadAndSendSuccessHandler,
  prodUploadSuccessHandler,
  prodUploadAndSendSuccessHandler,
];

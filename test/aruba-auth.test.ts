import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { setupServer } from 'msw/node';
import { delay, http, HttpResponse } from 'msw';
import { ArubaTokenManager, ArubaAuthTransientError, ArubaAuthPermanentError } from '../src/aruba/auth.js';
import { getArubaBaseUrl, getArubaAuthBaseUrl } from '../src/config/env.js';
import {
  DEMO_BASE,
  PROD_BASE,
  DEMO_AUTH_BASE,
  validTokenResponse,
  demoSigninHandler,
  prodSigninHandler,
} from './mocks/aruba.handlers.js';

const server = setupServer(demoSigninHandler, prodSigninHandler);

beforeAll(() => server.listen({ onUnhandledRequest: 'warn' }));
afterAll(() => server.close());
afterEach(() => server.resetHandlers());

describe('ArubaTokenManager', () => {
  it('first getToken triggers password-grant login', async () => {
    let capturedGrantType: string | null = null;
    server.use(
      http.post(`${DEMO_BASE}/auth/signin`, async ({ request }) => {
        capturedGrantType = new URLSearchParams(await request.text()).get('grant_type');
        return HttpResponse.json(validTokenResponse);
      }),
    );

    const manager = new ArubaTokenManager(DEMO_BASE, 'user@test.it', 'secret');
    const token = await manager.getToken();

    expect(token).toBe(validTokenResponse.access_token);
    expect(capturedGrantType).toBe('password');
  });

  it('caches token — second getToken does not re-request', async () => {
    let callCount = 0;
    server.use(
      http.post(`${DEMO_BASE}/auth/signin`, () => {
        callCount++;
        return HttpResponse.json(validTokenResponse);
      }),
    );

    const manager = new ArubaTokenManager(DEMO_BASE, 'user@test.it', 'secret');
    const t1 = await manager.getToken();
    const t2 = await manager.getToken();

    expect(t1).toBe(t2);
    expect(callCount).toBe(1);
  });

  it('proactively refreshes when token is within 60s buffer', async () => {
    let callCount = 0;
    let lastGrantType: string | null = null;
    server.use(
      http.post(`${DEMO_BASE}/auth/signin`, async ({ request }) => {
        callCount++;
        lastGrantType = new URLSearchParams(await request.text()).get('grant_type');
        return HttpResponse.json(validTokenResponse);
      }),
    );

    const manager = new ArubaTokenManager(DEMO_BASE, 'user@test.it', 'secret');
    await manager.getToken();
    expect(callCount).toBe(1);
    expect(lastGrantType).toBe('password');

    // Force near-expiry (30s remaining, buffer is 60s)
    (manager as any)._cached.expiresAt = Date.now() + 30_000;

    await manager.getToken();
    expect(callCount).toBe(2);
    expect(lastGrantType).toBe('refresh_token');
  });

  it('falls back to password login when refresh fails', async () => {
    let callCount = 0;
    let lastGrantType: string | null = null;
    server.use(
      http.post(`${DEMO_BASE}/auth/signin`, async ({ request }) => {
        callCount++;
        const grantType = new URLSearchParams(await request.text()).get('grant_type');
        lastGrantType = grantType;
        if (grantType === 'refresh_token') {
          return new HttpResponse(null, { status: 401 });
        }
        return HttpResponse.json(validTokenResponse);
      }),
    );

    const manager = new ArubaTokenManager(DEMO_BASE, 'user@test.it', 'secret');
    await manager.getToken();

    (manager as any)._cached.expiresAt = Date.now() + 30_000;

    const token = await manager.getToken();
    expect(token).toBe(validTokenResponse.access_token);
    // login → failed refresh → fallback login
    expect(callCount).toBe(3);
    expect(lastGrantType).toBe('password');
  });

  it('invalidate clears cache so next getToken re-authenticates', async () => {
    let callCount = 0;
    server.use(
      http.post(`${DEMO_BASE}/auth/signin`, () => {
        callCount++;
        return HttpResponse.json(validTokenResponse);
      }),
    );

    const manager = new ArubaTokenManager(DEMO_BASE, 'user@test.it', 'secret');
    await manager.getToken();
    manager.invalidate();
    await manager.getToken();

    expect(callCount).toBe(2);
  });

  it('ARUBA_ENV=DEMO → getArubaBaseUrl returns DEMO ws URL', () => {
    expect(getArubaBaseUrl()).toBe(DEMO_BASE);
  });

  it('ARUBA_ENV=DEMO → getArubaAuthBaseUrl returns DEMO auth URL', () => {
    expect(getArubaAuthBaseUrl()).toBe(DEMO_AUTH_BASE);
  });

  it('uses DEMO URL, not PROD URL', async () => {
    let demoCount = 0;
    let prodCount = 0;
    server.use(
      http.post(`${DEMO_BASE}/auth/signin`, () => {
        demoCount++;
        return HttpResponse.json(validTokenResponse);
      }),
      http.post(`${PROD_BASE}/auth/signin`, () => {
        prodCount++;
        return HttpResponse.json(validTokenResponse);
      }),
    );

    const manager = new ArubaTokenManager(DEMO_BASE, 'user@test.it', 'secret');
    await manager.getToken();

    expect(demoCount).toBe(1);
    expect(prodCount).toBe(0);
  });

  it('auth 503 throws ArubaAuthTransientError', async () => {
    server.use(
      http.post(`${DEMO_BASE}/auth/signin`, () =>
        new HttpResponse(null, { status: 503 }),
      ),
    );

    const manager = new ArubaTokenManager(DEMO_BASE, 'user@test.it', 'secret');
    await expect(manager.getToken()).rejects.toBeInstanceOf(ArubaAuthTransientError);
  });

  it('auth 503 ArubaAuthTransientError carries status 503', async () => {
    server.use(
      http.post(`${DEMO_BASE}/auth/signin`, () =>
        new HttpResponse(null, { status: 503 }),
      ),
    );

    const manager = new ArubaTokenManager(DEMO_BASE, 'user@test.it', 'secret');
    const err = await manager.getToken().catch((e) => e);
    expect(err).toBeInstanceOf(ArubaAuthTransientError);
    expect((err as ArubaAuthTransientError).status).toBe(503);
  });

  it('auth network error throws ArubaAuthTransientError with status undefined', async () => {
    server.use(
      http.post(`${DEMO_BASE}/auth/signin`, () => HttpResponse.error()),
    );

    const manager = new ArubaTokenManager(DEMO_BASE, 'user@test.it', 'secret');
    const err = await manager.getToken().catch((e) => e);
    expect(err).toBeInstanceOf(ArubaAuthTransientError);
    expect((err as ArubaAuthTransientError).status).toBeUndefined();
  });

  it('auth timeout throws ArubaAuthTransientError', async () => {
    server.use(
      http.post(`${DEMO_BASE}/auth/signin`, async () => {
        await delay(500);
        return HttpResponse.json(validTokenResponse);
      }),
    );

    const manager = new ArubaTokenManager(DEMO_BASE, 'user@test.it', 'secret', 50);
    await expect(manager.getToken()).rejects.toBeInstanceOf(ArubaAuthTransientError);
  }, 3000);

  it('login 401 throws ArubaAuthPermanentError with status 401', async () => {
    server.use(
      http.post(`${DEMO_BASE}/auth/signin`, () =>
        new HttpResponse(null, { status: 401 }),
      ),
    );

    const manager = new ArubaTokenManager(DEMO_BASE, 'user@test.it', 'wrongpassword');
    const err = await manager.getToken().catch((e) => e);
    expect(err).toBeInstanceOf(ArubaAuthPermanentError);
    expect((err as ArubaAuthPermanentError).status).toBe(401);
  });

  it('login 400 throws ArubaAuthPermanentError with status 400', async () => {
    server.use(
      http.post(`${DEMO_BASE}/auth/signin`, () =>
        new HttpResponse(null, { status: 400 }),
      ),
    );

    const manager = new ArubaTokenManager(DEMO_BASE, 'user@test.it', 'bad');
    const err = await manager.getToken().catch((e) => e);
    expect(err).toBeInstanceOf(ArubaAuthPermanentError);
    expect((err as ArubaAuthPermanentError).status).toBe(400);
  });

  it('refresh 401 is classified permanent, not transient', async () => {
    server.use(
      http.post(`${DEMO_BASE}/auth/signin`, async ({ request }) => {
        const grantType = new URLSearchParams(await request.text()).get('grant_type');
        if (grantType === 'refresh_token') return new HttpResponse(null, { status: 401 });
        return HttpResponse.json(validTokenResponse);
      }),
    );

    const manager = new ArubaTokenManager(DEMO_BASE, 'user@test.it', 'secret');
    await manager.getToken(); // initial login ok

    (manager as any)._cached.expiresAt = Date.now() + 30_000;

    // refresh 401 → falls back to login → succeeds (not thrown as transient)
    const token = await manager.getToken();
    expect(token).toBe(validTokenResponse.access_token);
  });

  it('fallback login after refresh 4xx, when login also 401, throws ArubaAuthPermanentError', async () => {
    let callCount = 0;
    server.use(
      http.post(`${DEMO_BASE}/auth/signin`, async ({ request }) => {
        callCount++;
        const grantType = new URLSearchParams(await request.text()).get('grant_type');
        if (grantType === 'password' && callCount === 1) return HttpResponse.json(validTokenResponse);
        return new HttpResponse(null, { status: 401 });
      }),
    );

    const manager = new ArubaTokenManager(DEMO_BASE, 'user@test.it', 'secret');
    await manager.getToken(); // initial login ok

    (manager as any)._cached.expiresAt = Date.now() + 30_000;

    const err = await manager.getToken().catch((e) => e);
    expect(err).toBeInstanceOf(ArubaAuthPermanentError);
    expect((err as ArubaAuthPermanentError).status).toBe(401);
  });

  it('transient refresh error propagates instead of falling back to login', async () => {
    let loginCount = 0;
    server.use(
      http.post(`${DEMO_BASE}/auth/signin`, async ({ request }) => {
        const grantType = new URLSearchParams(await request.text()).get('grant_type');
        if (grantType === 'password') loginCount++;
        if (grantType === 'refresh_token') return new HttpResponse(null, { status: 503 });
        return HttpResponse.json(validTokenResponse);
      }),
    );

    const manager = new ArubaTokenManager(DEMO_BASE, 'user@test.it', 'secret');
    await manager.getToken(); // initial login
    expect(loginCount).toBe(1);

    (manager as any)._cached.expiresAt = Date.now() + 30_000;

    const err = await manager.getToken().catch((e) => e);
    expect(err).toBeInstanceOf(ArubaAuthTransientError);
    // should NOT have fallen back to login
    expect(loginCount).toBe(1);
  });
});

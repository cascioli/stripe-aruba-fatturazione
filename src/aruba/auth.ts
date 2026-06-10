import { env, getArubaAuthBaseUrl } from '../config/env.js';

const REFRESH_BUFFER_MS = 60_000;

export class ArubaAuthTransientError extends Error {
  constructor(
    message: string,
    public readonly status: number | undefined,
  ) {
    super(message);
    this.name = 'ArubaAuthTransientError';
  }
}

export class ArubaAuthPermanentError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = 'ArubaAuthPermanentError';
  }
}

interface TokenResponse {
  access_token: string;
  expires_in: number;
  refresh_token: string;
  token_type: string;
}

interface CachedToken {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}

export class ArubaTokenManager {
  private _cached: CachedToken | null = null;

  constructor(
    private readonly baseUrl: string = getArubaAuthBaseUrl(),
    private readonly username: string = env.ARUBA_USERNAME,
    private readonly password: string = env.ARUBA_PASSWORD,
    private readonly timeoutMs: number = 30_000,
  ) {}

  async getToken(): Promise<string> {
    const now = Date.now();
    if (this._cached && this._cached.expiresAt - REFRESH_BUFFER_MS > now) {
      return this._cached.accessToken;
    }
    if (this._cached) {
      try {
        await this.refresh();
        return this._cached.accessToken;
      } catch (err) {
        if (err instanceof ArubaAuthTransientError) throw err;
        this._cached = null;
      }
    }
    await this.login();
    return this._cached!.accessToken;
  }

  invalidate(): void {
    this._cached = null;
  }

  private async authFetch(body: URLSearchParams): Promise<Response> {
    const ac = new AbortController();
    const timerId = setTimeout(() => ac.abort(), this.timeoutMs);
    try {
      return await fetch(`${this.baseUrl}/auth/signin`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
        signal: ac.signal,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new ArubaAuthTransientError(`Auth network error: ${msg}`, undefined);
    } finally {
      clearTimeout(timerId);
    }
  }

  private async login(): Promise<void> {
    const res = await this.authFetch(
      new URLSearchParams({
        grant_type: 'password',
        username: this.username,
        password: this.password,
      }),
    );
    if (res.status >= 500) {
      throw new ArubaAuthTransientError(`Aruba login server error: HTTP ${res.status}`, res.status);
    }
    if (!res.ok) throw new ArubaAuthPermanentError(`Aruba login failed: HTTP ${res.status}`, res.status);
    this.store(await res.json() as TokenResponse);
  }

  private async refresh(): Promise<void> {
    const res = await this.authFetch(
      new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: this._cached!.refreshToken,
      }),
    );
    if (res.status >= 500) {
      throw new ArubaAuthTransientError(`Aruba refresh server error: HTTP ${res.status}`, res.status);
    }
    if (!res.ok) throw new ArubaAuthPermanentError(`Aruba refresh failed: HTTP ${res.status}`, res.status);
    this.store(await res.json() as TokenResponse);
  }

  private store(data: TokenResponse): void {
    this._cached = {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresAt: Date.now() + data.expires_in * 1000,
    };
  }
}

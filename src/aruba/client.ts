import { env, getArubaBaseUrl } from '../config/env.js';
import type { FiscalInvoice } from '../domain/types.js';
import { ArubaTokenManager, ArubaAuthTransientError, ArubaAuthPermanentError } from './auth.js';
import { buildInvoicePayload, buildUploadEnvelope } from './payload-builder.js';
import type { ArubaInvoicePayload, CedenteConfig } from './payload-builder.js';
import { withRetry } from '../utils/retry.js';
import type { RetryOptions } from '../utils/retry.js';

export type ArubaUploadResult =
  | { ok: true; arubaInvoiceId: string }
  | { ok: false; retryable: false; status: number; message: string }
  | { ok: false; retryable: true; status: number | undefined; message: string };

class ArubaTransientError extends Error {
  constructor(
    message: string,
    public readonly status: number | undefined,
  ) {
    super(message);
    this.name = 'ArubaTransientError';
  }
}

export class ArubaClient {
  private readonly baseUrl: string;

  constructor(
    private readonly tokenManager: ArubaTokenManager,
    private readonly cedente: CedenteConfig,
    private readonly sendMode: 'DRAFT' | 'DIRECT' = env.ARUBA_SEND_MODE,
    private readonly retryOptions: RetryOptions = {},
    baseUrl?: string,
    private readonly timeoutMs: number = 30_000,
  ) {
    this.baseUrl = baseUrl ?? getArubaBaseUrl();
  }

  async uploadInvoice(invoice: FiscalInvoice): Promise<ArubaUploadResult> {
    const payload = buildInvoicePayload(invoice, this.cedente);
    try {
      return await withRetry(
        () => this._attemptUpload(payload),
        (err) => err instanceof ArubaTransientError,
        this.retryOptions,
      );
    } catch (err) {
      if (err instanceof ArubaTransientError) {
        return { ok: false, retryable: true, status: err.status, message: err.message };
      }
      throw err;
    }
  }

  private async _attemptUpload(payload: ArubaInvoicePayload): Promise<ArubaUploadResult> {
    let token: string;
    try {
      token = await this.tokenManager.getToken();
    } catch (err) {
      if (err instanceof ArubaAuthTransientError) {
        throw new ArubaTransientError(`Auth failed: ${err.message}`, err.status);
      }
      if (err instanceof ArubaAuthPermanentError) {
        return { ok: false, retryable: false, status: err.status, message: err.message };
      }
      throw err;
    }

    const endpoint =
      this.sendMode === 'DIRECT'
        ? '/services/invoice/out/uploadAndSendFile'
        : '/services/invoice/out/uploadFile';

    const ac = new AbortController();
    const timerId = setTimeout(() => ac.abort(), this.timeoutMs);

    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}${endpoint}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(buildUploadEnvelope(payload)),
        signal: ac.signal,
      });
    } catch (err) {
      throw new ArubaTransientError(
        `Network error: ${err instanceof Error ? err.message : String(err)}`,
        undefined,
      );
    } finally {
      clearTimeout(timerId);
    }

    if (res.ok) {
      const data = (await res.json()) as { arubaInvoiceId?: string };
      if (!data.arubaInvoiceId) {
        return {
          ok: false,
          retryable: false,
          status: res.status,
          message: 'Missing arubaInvoiceId in response',
        };
      }
      return { ok: true, arubaInvoiceId: data.arubaInvoiceId };
    }

    if (res.status >= 500) {
      throw new ArubaTransientError(`Server error: ${res.status}`, res.status);
    }

    const body = await res.text();
    return { ok: false, retryable: false, status: res.status, message: body };
  }
}

export function buildCedenteFromEnv(): CedenteConfig {
  return {
    partitaIva: env.ARUBA_CEDENTE_PIVA,
    denominazione: env.ARUBA_CEDENTE_DENOMINAZIONE,
    indirizzo: env.ARUBA_CEDENTE_INDIRIZZO,
    cap: env.ARUBA_CEDENTE_CAP,
    comune: env.ARUBA_CEDENTE_COMUNE,
    provincia: env.ARUBA_CEDENTE_PROVINCIA,
    nazione: env.ARUBA_CEDENTE_NAZIONE,
    regimeFiscale: env.ARUBA_CEDENTE_REGIME_FISCALE,
  };
}

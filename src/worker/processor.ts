import Stripe from 'stripe';
import { prisma } from '../db/prisma.js';
import { env, getArubaBaseUrl } from '../config/env.js';
import { JobStatus } from '../domain/types.js';
import type { FiscalInvoice } from '../domain/types.js';
import { validateFiscalData } from '../mapping/fiscal-validator.js';
import { normalizeInvoice, normalizeCharge } from '../mapping/normalizer.js';
import type { StripeInvoice, StripeCharge, TaxRateRegistry } from '../mapping/normalizer.js';
import { ArubaClient, buildCedenteFromEnv } from '../aruba/client.js';
import { ArubaTokenManager } from '../aruba/auth.js';
import { sendAlert } from '../notifications/alerter.js';
import { updateStripeMetadata } from '../stripe/metadata.js';

const stripe = new Stripe(env.STRIPE_SECRET_KEY, {
  // Wrap globalThis.fetch so MSW/test interceptors patched after module load are visible
  httpClient: Stripe.createFetchHttpClient((input, init) => globalThis.fetch(input, init)),
});

// Exponential backoff schedule for financial retries: 1m, 5m, 15m
export const RETRY_DELAYS_MS = [60_000, 5 * 60_000, 15 * 60_000];

function computeNextRetryAt(retryCount: number): Date {
  const delayMs = RETRY_DELAYS_MS[Math.min(retryCount - 1, RETRY_DELAYS_MS.length - 1)];
  return new Date(Date.now() + delayMs);
}

function buildTaxRateRegistry(invoice: Stripe.Invoice): TaxRateRegistry {
  const registry: TaxRateRegistry = {};
  for (const line of invoice.lines.data) {
    for (const ta of line.tax_amounts ?? []) {
      if (typeof ta.tax_rate === 'object' && ta.tax_rate !== null) {
        const tr = ta.tax_rate as Stripe.TaxRate;
        registry[tr.id] = { id: tr.id, percentage: tr.percentage, metadata: tr.metadata ?? undefined };
      }
    }
  }
  return registry;
}

function buildArubaClient(): ArubaClient {
  const tokenManager = new ArubaTokenManager(
    getArubaBaseUrl(),
    env.ARUBA_USERNAME,
    env.ARUBA_PASSWORD,
  );
  // maxAttempts: 1 — worker owns all retry scheduling via retryCount/nextRetryAt
  return new ArubaClient(tokenManager, buildCedenteFromEnv(), env.ARUBA_SEND_MODE, { maxAttempts: 1 });
}

interface RawStripeEvent {
  id: string;
  type: string;
  data: { object: Record<string, unknown> };
}

async function extractFiscalInvoice(job: {
  stripeEventId: string;
  eventType: string;
  rawPayload: string;
}): Promise<FiscalInvoice> {
  const event = JSON.parse(job.rawPayload) as RawStripeEvent;

  if (job.eventType === 'invoice.paid' || job.eventType === 'invoice.voided') {
    const rawObj = event.data.object as StripeInvoice & {
      customer?: string | { id: string; metadata?: Record<string, string> };
    };

    let customerMeta: Record<string, string>;
    let taxRateRegistry: TaxRateRegistry = {};

    if (typeof rawObj.customer === 'string') {
      const expanded = await stripe.invoices.retrieve(rawObj.id, {
        expand: ['customer', 'lines.data.tax_amounts.tax_rate'],
      });
      customerMeta =
        typeof expanded.customer === 'object' && expanded.customer !== null
          ? ((expanded.customer as Stripe.Customer).metadata ?? {})
          : {};
      taxRateRegistry = buildTaxRateRegistry(expanded);
    } else {
      customerMeta = rawObj.customer?.metadata ?? {};
      taxRateRegistry = buildTaxRateRegistry(event.data.object as unknown as Stripe.Invoice);
    }

    return normalizeInvoice(
      event.id,
      job.eventType as 'invoice.paid' | 'invoice.voided',
      rawObj,
      customerMeta,
      {},
      taxRateRegistry,
    );
  }

  if (job.eventType === 'charge.refunded') {
    const chargeObj = event.data.object as StripeCharge & { invoice: string | null };
    if (!chargeObj.invoice) {
      throw new Error('charge.refunded: missing invoice ID — cannot normalize');
    }

    const stripeInvoice = await stripe.invoices.retrieve(chargeObj.invoice, {
      expand: ['customer'],
    });

    const customerMeta =
      typeof stripeInvoice.customer === 'object' && stripeInvoice.customer !== null
        ? ((stripeInvoice.customer as Stripe.Customer).metadata ?? {})
        : {};

    const invoiceForNorm: StripeInvoice = {
      id: stripeInvoice.id,
      number: stripeInvoice.number ?? null,
      created: stripeInvoice.created,
      currency: stripeInvoice.currency,
      total: stripeInvoice.total,
      lines: {
        data: stripeInvoice.lines.data.map((l) => ({
          amount: l.amount,
          description: l.description ?? null,
          quantity: l.quantity ?? null,
          tax_amounts: l.tax_amounts?.map((ta) => ({
            amount: ta.amount,
            tax_rate:
              typeof ta.tax_rate === 'string'
                ? ta.tax_rate
                : {
                    id: (ta.tax_rate as Stripe.TaxRate).id,
                    percentage: (ta.tax_rate as Stripe.TaxRate).percentage,
                    metadata: (ta.tax_rate as Stripe.TaxRate).metadata ?? undefined,
                  },
          })),
        })),
      },
      metadata: stripeInvoice.metadata ?? {},
    };

    return normalizeCharge(event.id, chargeObj, customerMeta, invoiceForNorm);
  }

  throw new Error(`Unsupported eventType: ${job.eventType}`);
}

export async function processJob(jobId: string): Promise<void> {
  // 1. Idempotency re-check: re-read from DB before any Aruba call
  const job = await prisma.fatturaJob.findUnique({ where: { id: jobId } });
  if (!job) return;

  if (
    job.status === JobStatus.SENT_SDI ||
    job.status === JobStatus.CREATED_DRAFT ||
    job.arubaInvoiceId != null
  ) {
    console.info(
      JSON.stringify({
        level: 'info',
        event: 'job_idempotency_skip',
        jobId,
        status: job.status,
        arubaInvoiceId: job.arubaInvoiceId,
      }),
    );
    return;
  }

  if (job.status !== JobStatus.PENDING) return;
  if (job.nextRetryAt && job.nextRetryAt > new Date()) return;

  // 2. Normalize + validate (Driver phase)
  let fiscalInvoice: FiscalInvoice;
  try {
    fiscalInvoice = await extractFiscalInvoice(job);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await prisma.fatturaJob.update({
      where: { id: jobId },
      data: { status: JobStatus.FAILED_VALIDATION, lastError: message },
    });
    await sendAlert({
      jobId,
      stripeInvoiceId: job.stripeInvoiceId,
      reason: 'Normalization failed',
      errors: [message],
    });
    if (job.stripeInvoiceId) {
      await updateStripeMetadata(job.stripeInvoiceId, null, JobStatus.FAILED_VALIDATION).catch(
        () => {},
      );
    }
    return;
  }

  const validation = validateFiscalData(fiscalInvoice.customer);
  if (!validation.valid) {
    await prisma.fatturaJob.update({
      where: { id: jobId },
      data: {
        status: JobStatus.FAILED_VALIDATION,
        lastError: validation.errors.join('; '),
      },
    });
    await sendAlert({
      jobId,
      stripeInvoiceId: job.stripeInvoiceId,
      reason: 'Fiscal data validation failed',
      errors: validation.errors,
    });
    if (job.stripeInvoiceId) {
      await updateStripeMetadata(job.stripeInvoiceId, null, JobStatus.FAILED_VALIDATION).catch(
        () => {},
      );
    }
    return;
  }

  // 3. Call Aruba
  const arubaClient = buildArubaClient();
  const result = await arubaClient.uploadInvoice(fiscalInvoice);

  if (result.ok) {
    const newStatus =
      env.ARUBA_SEND_MODE === 'DIRECT' ? JobStatus.SENT_SDI : JobStatus.CREATED_DRAFT;
    await prisma.fatturaJob.update({
      where: { id: jobId },
      data: { status: newStatus, arubaInvoiceId: result.arubaInvoiceId, lastError: null },
    });
    if (job.stripeInvoiceId) {
      await updateStripeMetadata(job.stripeInvoiceId, result.arubaInvoiceId, newStatus).catch(
        () => {},
      );
    }
    return;
  }

  // 4. Retryable (5xx / network timeout): schedule next attempt with exponential backoff
  if (result.retryable) {
    const retryCount = job.retryCount + 1;
    await prisma.fatturaJob.update({
      where: { id: jobId },
      data: {
        retryCount,
        nextRetryAt: computeNextRetryAt(retryCount),
        lastError: result.message,
      },
    });
    return;
  }

  // 5. Non-retryable 4xx: permanent failure, no re-send
  const errorStatus =
    result.status === 400 || result.status === 422
      ? JobStatus.FAILED_VALIDATION
      : JobStatus.ERROR;

  await prisma.fatturaJob.update({
    where: { id: jobId },
    data: { status: errorStatus, lastError: result.message },
  });
  await sendAlert({
    jobId,
    stripeInvoiceId: job.stripeInvoiceId,
    reason: `Aruba rejected invoice (HTTP ${result.status ?? 'unknown'})`,
    errors: [result.message],
  });
  if (job.stripeInvoiceId) {
    await updateStripeMetadata(job.stripeInvoiceId, null, errorStatus).catch(() => {});
  }
}

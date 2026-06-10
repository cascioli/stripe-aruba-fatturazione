import Stripe from 'stripe';
import { prisma } from '../db/prisma.js';
import { env, getArubaAuthBaseUrl, getArubaBaseUrl } from '../config/env.js';
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

// A job locked for longer than this duration is considered stale and may be re-claimed.
export const STALE_LOCK_MS = 10 * 60_000;

// Metadata sync status constants — kept in sync with schema comment.
export const META_SYNC_PENDING = 'PENDING';
export const META_SYNC_OK = 'OK';
export const META_SYNC_FAILED = 'FAILED';

// Unique identifier for this worker process instance.
const WORKER_ID = `worker-${process.pid}-${Date.now()}`;

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
    getArubaAuthBaseUrl(),
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
  stripeRefundId: string | null;
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

    // Expand both customer and tax rates so credit notes preserve the correct IVA treatment
    const stripeInvoice = await stripe.invoices.retrieve(chargeObj.invoice, {
      expand: ['customer', 'lines.data.tax_amounts.tax_rate'],
    });

    const customerMeta =
      typeof stripeInvoice.customer === 'object' && stripeInvoice.customer !== null
        ? ((stripeInvoice.customer as Stripe.Customer).metadata ?? {})
        : {};

    const taxRateRegistry = buildTaxRateRegistry(stripeInvoice);

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

    // stripeRefundId was set deterministically at webhook time; use it to select the specific
    // refund entry rather than falling back to the cumulative charge.amount_refunded.
    if (!job.stripeRefundId) {
      throw new Error('charge.refunded: stripeRefundId not set — cannot determine individual refund amount');
    }
    const matchedRefund = chargeObj.refunds?.data?.find((r) => r.id === job.stripeRefundId);
    if (!matchedRefund) {
      throw new Error(
        `charge.refunded: refund '${job.stripeRefundId}' not found in charge payload refunds`,
      );
    }
    const refundAmountOverride = matchedRefund.amount;

    return normalizeCharge(
      event.id,
      chargeObj,
      customerMeta,
      invoiceForNorm,
      {},
      taxRateRegistry,
      refundAmountOverride,
    );
  }

  throw new Error(`Unsupported eventType: ${job.eventType}`);
}

/**
 * Perform (or retry) the Stripe metadata write-back without re-invoking Aruba.
 * Handles both success states (arubaInvoiceId present) and failure states (arubaInvoiceId null).
 */
async function retryMetadataSync(job: {
  id: string;
  stripeInvoiceId: string | null;
  arubaInvoiceId: string | null;
  status: string;
}): Promise<void> {
  if (!job.stripeInvoiceId) return;

  try {
    await updateStripeMetadata(job.stripeInvoiceId, job.arubaInvoiceId, job.status);
    await prisma.fatturaJob.update({
      where: { id: job.id },
      data: { metadataSyncStatus: META_SYNC_OK },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await prisma.fatturaJob.update({
      where: { id: job.id },
      data: { metadataSyncStatus: META_SYNC_FAILED },
    });
    await sendAlert({
      jobId: job.id,
      stripeInvoiceId: job.stripeInvoiceId,
      reason: 'Stripe metadata sync failed',
      errors: [message],
    });
  }
}

export async function processJob(jobId: string): Promise<void> {
  const now = new Date();
  const staleCutoff = new Date(now.getTime() - STALE_LOCK_MS);

  // Atomic claim: only one worker can acquire this job for an Aruba call at a time.
  // The updateMany only succeeds when the job is PENDING, has no arubaInvoiceId,
  // is due for processing (nextRetryAt <= now), and holds no fresh lock.
  const claimed = await prisma.fatturaJob.updateMany({
    where: {
      id: jobId,
      status: JobStatus.PENDING,
      arubaInvoiceId: null,
      AND: [
        { OR: [{ nextRetryAt: null }, { nextRetryAt: { lte: now } }] },
        { OR: [{ lockedAt: null }, { lockedAt: { lte: staleCutoff } }] },
      ],
    },
    data: { lockedAt: now, lockedBy: WORKER_ID },
  });

  if (claimed.count === 0) {
    // Job not claimable for Aruba — handle alert + metadata-only retry as needed.
    const job = await prisma.fatturaJob.findUnique({ where: { id: jobId } });
    if (!job) return;

    // Atomic alert gate: exactly-once alert for failure-state jobs created by the webhook.
    // updateMany constrained by alerted:false ensures two concurrent workers cannot both send.
    if (job.status === JobStatus.FAILED_VALIDATION || job.status === JobStatus.ERROR) {
      const alertClaimed = await prisma.fatturaJob.updateMany({
        where: {
          id: jobId,
          alerted: false,
          status: { in: [JobStatus.FAILED_VALIDATION, JobStatus.ERROR] },
        },
        data: { alerted: true },
      });
      if (alertClaimed.count === 1) {
        await sendAlert({
          jobId,
          stripeInvoiceId: job.stripeInvoiceId,
          reason: job.lastError ?? 'Job in failure state',
          errors: job.lastError ? [job.lastError] : [],
        });
      }
    }

    if (
      job.stripeInvoiceId &&
      (job.metadataSyncStatus === META_SYNC_PENDING || job.metadataSyncStatus === META_SYNC_FAILED)
    ) {
      await retryMetadataSync(job);
    }
    return;
  }

  // Re-read the full job record after acquiring the lock.
  const job = await prisma.fatturaJob.findUnique({ where: { id: jobId } });
  if (!job) return;

  // Belt-and-suspenders: prevent double Aruba calls when two jobs share a fiscal document key.
  if (job.fiscalDocumentKey) {
    const existing = await prisma.fatturaJob.findFirst({
      where: {
        fiscalDocumentKey: job.fiscalDocumentKey,
        id: { not: jobId },
        arubaInvoiceId: { not: null },
      },
    });
    if (existing) {
      await prisma.fatturaJob.update({
        where: { id: jobId },
        data: {
          status: JobStatus.ERROR,
          lastError: 'Fiscal document already issued by another job',
          lockedAt: null,
          lockedBy: null,
          metadataSyncStatus: job.stripeInvoiceId ? META_SYNC_PENDING : null,
          alerted: true,
        },
      });
      await sendAlert({
        jobId,
        stripeInvoiceId: job.stripeInvoiceId,
        reason: 'Fiscal document already issued by another job',
        errors: ['Fiscal document already issued by another job'],
      });
      if (job.stripeInvoiceId) {
        await retryMetadataSync({ ...job, arubaInvoiceId: null, status: JobStatus.ERROR });
      }
      return;
    }
  }

  // 2. Normalize + validate (Driver phase)
  let fiscalInvoice: FiscalInvoice;
  try {
    fiscalInvoice = await extractFiscalInvoice(job);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await prisma.fatturaJob.update({
      where: { id: jobId },
      data: {
        status: JobStatus.FAILED_VALIDATION,
        lastError: message,
        lockedAt: null,
        lockedBy: null,
        metadataSyncStatus: job.stripeInvoiceId ? META_SYNC_PENDING : null,
        alerted: true,
      },
    });
    await sendAlert({
      jobId,
      stripeInvoiceId: job.stripeInvoiceId,
      reason: 'Normalization failed',
      errors: [message],
    });
    if (job.stripeInvoiceId) {
      await retryMetadataSync({ ...job, arubaInvoiceId: null, status: JobStatus.FAILED_VALIDATION });
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
        lockedAt: null,
        lockedBy: null,
        metadataSyncStatus: job.stripeInvoiceId ? META_SYNC_PENDING : null,
        alerted: true,
      },
    });
    await sendAlert({
      jobId,
      stripeInvoiceId: job.stripeInvoiceId,
      reason: 'Fiscal data validation failed',
      errors: validation.errors,
    });
    if (job.stripeInvoiceId) {
      await retryMetadataSync({ ...job, arubaInvoiceId: null, status: JobStatus.FAILED_VALIDATION });
    }
    return;
  }

  // 3. Call Aruba
  const arubaClient = buildArubaClient();
  const result = await arubaClient.uploadInvoice(fiscalInvoice);

  if (result.ok) {
    const newStatus =
      env.ARUBA_SEND_MODE === 'DIRECT' ? JobStatus.SENT_SDI : JobStatus.CREATED_DRAFT;

    // Persist Aruba success BEFORE attempting the Stripe metadata write-back.
    // If metadata sync fails later, the arubaInvoiceId is already stored and the
    // metadataSyncStatus flag allows a metadata-only retry without re-calling Aruba.
    await prisma.fatturaJob.update({
      where: { id: jobId },
      data: {
        status: newStatus,
        arubaInvoiceId: result.arubaInvoiceId,
        lastError: null,
        lockedAt: null,
        lockedBy: null,
        metadataSyncStatus: META_SYNC_PENDING,
      },
    });

    if (job.stripeInvoiceId) {
      try {
        await updateStripeMetadata(job.stripeInvoiceId, result.arubaInvoiceId, newStatus);
        await prisma.fatturaJob.update({
          where: { id: jobId },
          data: { metadataSyncStatus: META_SYNC_OK },
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await prisma.fatturaJob.update({
          where: { id: jobId },
          data: { metadataSyncStatus: META_SYNC_FAILED },
        });
        await sendAlert({
          jobId,
          stripeInvoiceId: job.stripeInvoiceId,
          reason: 'Stripe metadata sync failed after Aruba success',
          errors: [message],
        });
      }
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
        lockedAt: null,
        lockedBy: null,
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
    data: {
      status: errorStatus,
      lastError: result.message,
      lockedAt: null,
      lockedBy: null,
      metadataSyncStatus: job.stripeInvoiceId ? META_SYNC_PENDING : null,
      alerted: true,
    },
  });
  await sendAlert({
    jobId,
    stripeInvoiceId: job.stripeInvoiceId,
    reason: `Aruba rejected invoice (HTTP ${result.status ?? 'unknown'})`,
    errors: [result.message],
  });
  if (job.stripeInvoiceId) {
    await retryMetadataSync({ ...job, arubaInvoiceId: null, status: errorStatus });
  }
}

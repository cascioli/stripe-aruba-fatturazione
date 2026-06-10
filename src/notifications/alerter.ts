import { env } from '../config/env.js';

export interface AlertPayload {
  jobId: string;
  stripeInvoiceId: string | null;
  reason: string;
  errors: string[];
}

export async function sendAlert(payload: AlertPayload): Promise<void> {
  console.error(
    JSON.stringify({
      level: 'error',
      event: 'invoice_alert',
      timestamp: new Date().toISOString(),
      ...payload,
    }),
  );

  if (!env.ALERT_WEBHOOK_URL) return;

  try {
    await fetch(env.ALERT_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch {
    // best-effort: alert delivery failure must not crash the worker
  }
}

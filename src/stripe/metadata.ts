import Stripe from 'stripe';
import { env } from '../config/env.js';

const stripe = new Stripe(env.STRIPE_SECRET_KEY, {
  // Wrap globalThis.fetch so MSW/test interceptors patched after module load are visible
  httpClient: Stripe.createFetchHttpClient((input, init) => globalThis.fetch(input, init)),
});

export async function updateStripeMetadata(
  stripeInvoiceId: string,
  arubaInvoiceId: string | null,
  arubaStatus: string,
): Promise<void> {
  const metadata: Record<string, string> = { aruba_status: arubaStatus };
  if (arubaInvoiceId) metadata['aruba_invoice_id'] = arubaInvoiceId;

  await stripe.invoices.update(stripeInvoiceId, { metadata });
}

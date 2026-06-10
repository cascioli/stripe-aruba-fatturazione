import type {
  FiscalInvoice,
  FiscalLineItem,
  FiscalMetadata,
  FiscalTotals,
  NaturaIva,
  TipoDocumento,
} from '../domain/types.js';
import { resolveNaturaIva, type TaxRateInfo } from './natura-iva.js';

// Minimal Stripe-compatible interfaces (subset needed — avoids tight SDK coupling in tests)
export interface StripeTaxRate {
  id: string;
  percentage: number;
  metadata?: Record<string, string>;
}

export interface StripeLineItem {
  amount: number;
  description: string | null;
  quantity: number | null;
  tax_amounts?: Array<{
    amount: number;
    tax_rate: StripeTaxRate | string;
  }>;
}

export interface StripeInvoice {
  id: string;
  number: string | null;
  created: number;
  currency: string;
  total: number;
  lines: { data: StripeLineItem[] };
  metadata?: Record<string, string>;
  /** Customer metadata embedded in the webhook payload (Stripe expands this in invoice events). */
  customer_metadata?: Record<string, string>;
}

export interface StripeCharge {
  id: string;
  invoice: string | null;
  amount: number;
  amount_refunded: number;
  currency: string;
  created: number;
  metadata?: Record<string, string>;
}

/**
 * Registry mapping unexpanded Stripe tax-rate IDs to their full TaxRateInfo.
 * Required when invoice payloads carry tax_rate as a string ID rather than an expanded object.
 */
export type TaxRateRegistry = Record<string, TaxRateInfo>;

/** Half-up rounding to 2 decimal places, safe for floating-point inputs. */
export function halfUp(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

/** Convert Stripe integer cents to EUR with half-up rounding. */
export function centsToEur(cents: number): number {
  return halfUp(cents / 100);
}

function extractFiscalMetadata(
  customerMeta: Record<string, string>,
  invoiceMeta: Record<string, string> = {},
): FiscalMetadata {
  // Invoice metadata overrides customer metadata per-invoice
  const m = { ...customerMeta, ...invoiceMeta };
  return {
    vatNumber: m['vat_number'] ?? m['partita_iva'] ?? undefined,
    codiceFiscale: m['codice_fiscale'] ?? undefined,
    sdiCode: m['sdi_code'] ?? m['codice_destinatario'] ?? undefined,
    pec: m['pec'] ?? undefined,
    denominazione: m['denominazione'] ?? undefined,
    nome: m['nome'] ?? undefined,
    cognome: m['cognome'] ?? undefined,
    indirizzo: m['indirizzo'] ?? '',
    cap: m['cap'] ?? '',
    comune: m['comune'] ?? '',
    provincia: m['provincia'] ?? '',
    nazione: m['nazione'] ?? 'IT',
  };
}

/**
 * Resolve a tax_rate field (expanded object or string ID) to vatRate/natura.
 * Throws if the ID is unexpanded and not found in customNaturaMap or registry.
 */
function resolveTaxRateVat(
  raw: StripeTaxRate | string,
  customNaturaMap: Record<string, NaturaIva>,
  registry: TaxRateRegistry,
): { vatRate: number | null; natura: NaturaIva | null } {
  if (typeof raw !== 'string') {
    return resolveNaturaIva({ id: raw.id, percentage: raw.percentage, metadata: raw.metadata }, customNaturaMap);
  }

  // String ID: check customNaturaMap first (direct Natura override by ID)
  if (customNaturaMap[raw]) {
    return { vatRate: null, natura: customNaturaMap[raw] };
  }

  // Lookup registry for full tax-rate info
  const info = registry[raw];
  if (info) {
    return resolveNaturaIva(info, customNaturaMap);
  }

  throw new Error(
    `Tax rate '${raw}' is unexpanded and not in taxRateRegistry; cannot determine aliquota or Natura IVA`,
  );
}

function buildLineItem(
  line: StripeLineItem,
  customNaturaMap: Record<string, NaturaIva>,
  registry: TaxRateRegistry,
): FiscalLineItem {
  const quantity = line.quantity ?? 1;
  const taxableAmount = centsToEur(line.amount);

  const firstTax = line.tax_amounts?.[0];
  const vatAmount = centsToEur(firstTax?.amount ?? 0);

  let vatRate: number | null = null;
  let natura: NaturaIva | null = null;

  if (firstTax) {
    ({ vatRate, natura } = resolveTaxRateVat(firstTax.tax_rate, customNaturaMap, registry));
  } else {
    // No tax configured → treat as exempt
    natura = 'N4';
  }

  return {
    description: line.description ?? '',
    quantity,
    unitPrice: halfUp(taxableAmount / quantity),
    vatRate,
    natura,
    taxableAmount,
    vatAmount,
  };
}

function sumTotals(items: FiscalLineItem[]): FiscalTotals {
  let taxable = 0;
  let vat = 0;
  for (const item of items) {
    taxable = halfUp(taxable + item.taxableAmount);
    vat = halfUp(vat + item.vatAmount);
  }
  return { taxable, vat, grand: halfUp(taxable + vat) };
}

/** Exact integer-cents comparison — no business-value tolerance. */
function assertConsistency(computed: number, stripeTotal: number): void {
  const computedCents = Math.round(computed * 100);
  const stripeCents = Math.round(stripeTotal * 100);
  if (computedCents !== stripeCents) {
    throw new Error(
      `Incoerenza importi: totale calcolato ${computed.toFixed(2)} EUR ≠ totale Stripe ${stripeTotal.toFixed(2)} EUR`,
    );
  }
}

/**
 * Normalize a Stripe invoice (invoice.paid or invoice.voided) into a FiscalInvoice.
 * Pure function — no I/O, no side effects.
 */
export function normalizeInvoice(
  stripeEventId: string,
  eventType: 'invoice.paid' | 'invoice.voided',
  invoice: StripeInvoice,
  customerMeta: Record<string, string>,
  customNaturaMap: Record<string, NaturaIva> = {},
  taxRateRegistry: TaxRateRegistry = {},
): FiscalInvoice {
  const tipoDocumento: TipoDocumento = eventType === 'invoice.paid' ? 'TD01' : 'TD04';
  const customer = extractFiscalMetadata(customerMeta, invoice.metadata ?? {});
  const lineItems = invoice.lines.data.map((l) => buildLineItem(l, customNaturaMap, taxRateRegistry));
  const totals = sumTotals(lineItems);

  assertConsistency(totals.grand, centsToEur(invoice.total));

  return {
    stripeInvoiceId: invoice.id,
    stripeEventId,
    tipoDocumento,
    number: invoice.number ?? invoice.id,
    date: new Date(invoice.created * 1000),
    currency: invoice.currency.toUpperCase(),
    customer,
    lineItems,
    totals,
  };
}

/**
 * Normalize a Stripe charge refund (charge.refunded) into a FiscalInvoice (TD04).
 *
 * Requires the original StripeInvoice to preserve aliquota/Natura IVA on the credit note.
 * Throws deterministically when invoice is absent so the caller can reject rather than emit
 * a fiscally incorrect fallback for an unknown tax treatment.
 *
 * Fiscal metadata precedence: customerMeta → invoice.metadata → charge.metadata.
 * Partial refunds prorate each line by the refund ratio with a deterministic last-line
 * adjustment to absorb rounding so the total matches amount_refunded exactly.
 */
export function normalizeCharge(
  stripeEventId: string,
  charge: StripeCharge,
  customerMeta: Record<string, string>,
  invoice: StripeInvoice,
  customNaturaMap: Record<string, NaturaIva> = {},
  taxRateRegistry: TaxRateRegistry = {},
): FiscalInvoice {
  if (!invoice) {
    throw new Error(
      'StripeInvoice richiesto per nota di credito TD04: trattamento IVA non determinabile senza la fattura originale',
    );
  }

  // Precedence: customerMeta → invoice.metadata → charge.metadata
  const customer = extractFiscalMetadata(
    { ...customerMeta, ...(invoice.metadata ?? {}) },
    charge.metadata ?? {},
  );

  let lineItems: FiscalLineItem[];

  if (charge.amount > 0) {
    const originalItems = invoice.lines.data.map((l) =>
      buildLineItem(l, customNaturaMap, taxRateRegistry),
    );

    if (charge.amount_refunded === charge.amount) {
      // Full refund: mirror original invoice lines exactly
      lineItems = originalItems;
    } else {
      // Partial refund: prorate each line by ratio
      const ratio = charge.amount_refunded / charge.amount;
      lineItems = originalItems.map((item) => ({
        ...item,
        taxableAmount: halfUp(item.taxableAmount * ratio),
        vatAmount: halfUp(item.vatAmount * ratio),
        unitPrice: halfUp((item.taxableAmount * ratio) / item.quantity),
      }));

      // Deterministic rounding fix: adjust last line's taxableAmount to absorb any cent diff
      const sumGrand = halfUp(lineItems.reduce((s, i) => s + i.taxableAmount + i.vatAmount, 0));
      const expectedGrand = centsToEur(charge.amount_refunded);
      const diff = halfUp(expectedGrand - sumGrand);
      if (diff !== 0) {
        const last = lineItems[lineItems.length - 1];
        last.taxableAmount = halfUp(last.taxableAmount + diff);
        last.unitPrice = halfUp(last.taxableAmount / last.quantity);
      }
    }
  } else {
    lineItems = [];
  }

  const totals = sumTotals(lineItems);
  assertConsistency(totals.grand, centsToEur(charge.amount_refunded));

  return {
    stripeInvoiceId: charge.invoice ?? charge.id,
    stripeEventId,
    tipoDocumento: 'TD04',
    number: charge.id,
    date: new Date(charge.created * 1000),
    currency: charge.currency.toUpperCase(),
    customer,
    lineItems,
    totals,
  };
}

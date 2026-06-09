import { describe, it, expect } from 'vitest';
import type { FiscalInvoice } from '../src/domain/types.js';
import {
  halfUp,
  centsToEur,
  normalizeInvoice,
  normalizeCharge,
  type StripeInvoice,
  type StripeCharge,
  type StripeLineItem,
  type TaxRateRegistry,
} from '../src/mapping/normalizer.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCustomerMeta(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    vat_number: '00159560366',
    sdi_code: '0000000',
    denominazione: 'ACME Srl',
    indirizzo: 'Via Roma 1',
    cap: '40100',
    comune: 'Bologna',
    provincia: 'BO',
    nazione: 'IT',
    ...overrides,
  };
}

function makeLineItem(overrides: Partial<StripeLineItem> = {}): StripeLineItem {
  return {
    amount: 10000,
    description: 'Servizio SaaS mensile',
    quantity: 1,
    tax_amounts: [
      {
        amount: 2200,
        tax_rate: { id: 'txr_22', percentage: 22, metadata: {} },
      },
    ],
    ...overrides,
  };
}

function makeInvoice(overrides: Partial<StripeInvoice> = {}): StripeInvoice {
  return {
    id: 'in_test_001',
    number: 'INV-0001',
    created: 1700000000,
    currency: 'eur',
    total: 12200,
    lines: { data: [makeLineItem()] },
    ...overrides,
  };
}

function makeCharge(overrides: Partial<StripeCharge> = {}): StripeCharge {
  return {
    id: 'ch_test_001',
    invoice: 'in_test_001',
    amount: 12200,
    amount_refunded: 12200,
    currency: 'eur',
    created: 1700000100,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// halfUp rounding
// ---------------------------------------------------------------------------

describe('halfUp', () => {
  it('rounds .5 up', () => {
    expect(halfUp(1.005)).toBe(1.01);
    expect(halfUp(2.515)).toBe(2.52);
  });

  it('rounds .4 down', () => {
    expect(halfUp(1.004)).toBe(1.00);
    expect(halfUp(0.994)).toBe(0.99);
  });

  it('exact values unchanged', () => {
    expect(halfUp(100.00)).toBe(100.00);
    expect(halfUp(0.01)).toBe(0.01);
  });

  it('handles zero', () => {
    expect(halfUp(0)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// centsToEur
// ---------------------------------------------------------------------------

describe('centsToEur', () => {
  it('converts standard amounts', () => {
    expect(centsToEur(12200)).toBe(122.00);
    expect(centsToEur(10000)).toBe(100.00);
    expect(centsToEur(1)).toBe(0.01);
  });

  it('applies half-up rounding', () => {
    expect(centsToEur(333)).toBe(3.33);
    expect(centsToEur(1)).toBe(0.01);
  });

  it('zero stays zero', () => {
    expect(centsToEur(0)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// normalizeInvoice — TipoDocumento
// ---------------------------------------------------------------------------

describe('normalizeInvoice – TipoDocumento', () => {
  it('TD01 for invoice.paid', () => {
    const result = normalizeInvoice('evt_1', 'invoice.paid', makeInvoice(), makeCustomerMeta());
    expect(result.tipoDocumento).toBe('TD01');
  });

  it('TD04 for invoice.voided', () => {
    const result = normalizeInvoice('evt_2', 'invoice.voided', makeInvoice(), makeCustomerMeta());
    expect(result.tipoDocumento).toBe('TD04');
  });
});

// ---------------------------------------------------------------------------
// normalizeInvoice — return type contract (Comment 4)
// ---------------------------------------------------------------------------

describe('normalizeInvoice – FiscalInvoice contract', () => {
  it('return value satisfies FiscalInvoice type', () => {
    const result: FiscalInvoice = normalizeInvoice('evt_1', 'invoice.paid', makeInvoice(), makeCustomerMeta());
    expect(result.tipoDocumento).toBeDefined();
    expect(result.totals).toBeDefined();
    expect(result.lineItems[0].vatRate).toBeDefined();
    expect(result.lineItems[0].natura).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// normalizeInvoice — amounts
// ---------------------------------------------------------------------------

describe('normalizeInvoice – amounts', () => {
  it('converts line item amounts from cents to EUR', () => {
    const result = normalizeInvoice('evt_1', 'invoice.paid', makeInvoice(), makeCustomerMeta());
    const line = result.lineItems[0];
    expect(line.taxableAmount).toBe(100.00);
    expect(line.vatAmount).toBe(22.00);
  });

  it('computes totals correctly', () => {
    const result = normalizeInvoice('evt_1', 'invoice.paid', makeInvoice(), makeCustomerMeta());
    expect(result.totals.taxable).toBe(100.00);
    expect(result.totals.vat).toBe(22.00);
    expect(result.totals.grand).toBe(122.00);
  });

  it('handles multiple line items and sums totals', () => {
    const inv = makeInvoice({
      total: 24400,
      lines: {
        data: [
          makeLineItem({ amount: 10000, tax_amounts: [{ amount: 2200, tax_rate: { id: 'txr_22', percentage: 22 } }] }),
          makeLineItem({ amount: 10000, tax_amounts: [{ amount: 2200, tax_rate: { id: 'txr_22', percentage: 22 } }] }),
        ],
      },
    });
    const result = normalizeInvoice('evt_1', 'invoice.paid', inv, makeCustomerMeta());
    expect(result.totals.taxable).toBe(200.00);
    expect(result.totals.vat).toBe(44.00);
    expect(result.totals.grand).toBe(244.00);
  });

  it('uses invoice.number when present', () => {
    const result = normalizeInvoice('evt_1', 'invoice.paid', makeInvoice(), makeCustomerMeta());
    expect(result.number).toBe('INV-0001');
  });

  it('falls back to invoice.id when number is null', () => {
    const result = normalizeInvoice('evt_1', 'invoice.paid', makeInvoice({ number: null }), makeCustomerMeta());
    expect(result.number).toBe('in_test_001');
  });

  it('uppercases currency', () => {
    const result = normalizeInvoice('evt_1', 'invoice.paid', makeInvoice({ currency: 'eur' }), makeCustomerMeta());
    expect(result.currency).toBe('EUR');
  });

  it('converts unix timestamp to Date', () => {
    const result = normalizeInvoice('evt_1', 'invoice.paid', makeInvoice(), makeCustomerMeta());
    expect(result.date).toEqual(new Date(1700000000 * 1000));
  });
});

// ---------------------------------------------------------------------------
// normalizeInvoice — consistency check (Comment 3)
// ---------------------------------------------------------------------------

describe('normalizeInvoice – consistency check', () => {
  it('throws when computed grand total differs from Stripe total by any amount', () => {
    const inv = makeInvoice({
      total: 20000, // 200 EUR
      lines: { data: [makeLineItem({ amount: 5000, tax_amounts: [] })] }, // 50 EUR, no VAT
    });
    expect(() =>
      normalizeInvoice('evt_1', 'invoice.paid', inv, makeCustomerMeta()),
    ).toThrow('Incoerenza importi');
  });

  it('rejects one-cent mismatch', () => {
    // computed 122.00, Stripe says 122.01
    const inv = makeInvoice({ total: 12201 });
    expect(() =>
      normalizeInvoice('evt_1', 'invoice.paid', inv, makeCustomerMeta()),
    ).toThrow('Incoerenza importi');
  });

  it('rejects four-cent mismatch', () => {
    // computed 122.00, Stripe says 122.04
    const inv = makeInvoice({ total: 12204 });
    expect(() =>
      normalizeInvoice('evt_1', 'invoice.paid', inv, makeCustomerMeta()),
    ).toThrow('Incoerenza importi');
  });

  it('passes when rounded totals are exactly equal', () => {
    // computed 122.00, Stripe 122.00
    expect(() =>
      normalizeInvoice('evt_1', 'invoice.paid', makeInvoice(), makeCustomerMeta()),
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// normalizeInvoice — Natura IVA mapping
// ---------------------------------------------------------------------------

describe('normalizeInvoice – Natura IVA', () => {
  it('sets vatRate for standard 22% rate', () => {
    const result = normalizeInvoice('evt_1', 'invoice.paid', makeInvoice(), makeCustomerMeta());
    expect(result.lineItems[0].vatRate).toBe(22);
    expect(result.lineItems[0].natura).toBeNull();
  });

  it('sets N4 (esente) for 0% rate with no metadata', () => {
    const inv = makeInvoice({
      total: 10000,
      lines: {
        data: [makeLineItem({
          amount: 10000,
          tax_amounts: [{ amount: 0, tax_rate: { id: 'txr_0', percentage: 0 } }],
        })],
      },
    });
    const result = normalizeInvoice('evt_1', 'invoice.paid', inv, makeCustomerMeta());
    expect(result.lineItems[0].vatRate).toBeNull();
    expect(result.lineItems[0].natura).toBe('N4');
  });

  it('reads natura from tax rate metadata.natura_iva', () => {
    const inv = makeInvoice({
      total: 10000,
      lines: {
        data: [makeLineItem({
          amount: 10000,
          tax_amounts: [{ amount: 0, tax_rate: { id: 'txr_esclusa', percentage: 0, metadata: { natura_iva: 'N1' } } }],
        })],
      },
    });
    const result = normalizeInvoice('evt_1', 'invoice.paid', inv, makeCustomerMeta());
    expect(result.lineItems[0].natura).toBe('N1');
  });

  it('custom map overrides metadata.natura_iva', () => {
    const inv = makeInvoice({
      total: 10000,
      lines: {
        data: [makeLineItem({
          amount: 10000,
          tax_amounts: [{ amount: 0, tax_rate: { id: 'txr_x', percentage: 0, metadata: { natura_iva: 'N1' } } }],
        })],
      },
    });
    const result = normalizeInvoice('evt_1', 'invoice.paid', inv, makeCustomerMeta(), { txr_x: 'N3.1' });
    expect(result.lineItems[0].natura).toBe('N3.1');
  });

  it('defaults to N4 when tax_amounts is empty array', () => {
    const inv = makeInvoice({
      total: 10000,
      lines: { data: [makeLineItem({ amount: 10000, tax_amounts: [] })] },
    });
    const result = normalizeInvoice('evt_1', 'invoice.paid', inv, makeCustomerMeta());
    expect(result.lineItems[0].natura).toBe('N4');
    expect(result.lineItems[0].vatRate).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// normalizeInvoice — unexpanded tax-rate IDs (Comment 2)
// ---------------------------------------------------------------------------

describe('normalizeInvoice – unexpanded tax-rate IDs', () => {
  it('throws when string tax-rate ID is not in registry', () => {
    const inv = makeInvoice({
      lines: { data: [makeLineItem({ tax_amounts: [{ amount: 2200, tax_rate: 'txr_unknown' }] })] },
    });
    expect(() =>
      normalizeInvoice('evt_1', 'invoice.paid', inv, makeCustomerMeta()),
    ).toThrow("Tax rate 'txr_unknown' is unexpanded and not in taxRateRegistry");
  });

  it('resolves string ID via registry for standard VAT', () => {
    const registry: TaxRateRegistry = { txr_22_str: { id: 'txr_22_str', percentage: 22 } };
    const inv = makeInvoice({
      lines: { data: [makeLineItem({ tax_amounts: [{ amount: 2200, tax_rate: 'txr_22_str' }] })] },
    });
    const result = normalizeInvoice('evt_1', 'invoice.paid', inv, makeCustomerMeta(), {}, registry);
    expect(result.lineItems[0].vatRate).toBe(22);
    expect(result.lineItems[0].natura).toBeNull();
  });

  it('resolves string ID via registry with Natura from metadata', () => {
    const registry: TaxRateRegistry = {
      txr_esente_str: { id: 'txr_esente_str', percentage: 0, metadata: { natura_iva: 'N2.1' } },
    };
    const inv = makeInvoice({
      total: 10000,
      lines: { data: [makeLineItem({ amount: 10000, tax_amounts: [{ amount: 0, tax_rate: 'txr_esente_str' }] })] },
    });
    const result = normalizeInvoice('evt_1', 'invoice.paid', inv, makeCustomerMeta(), {}, registry);
    expect(result.lineItems[0].vatRate).toBeNull();
    expect(result.lineItems[0].natura).toBe('N2.1');
  });

  it('resolves string ID via customNaturaMap before registry lookup', () => {
    const inv = makeInvoice({
      total: 10000,
      lines: { data: [makeLineItem({ amount: 10000, tax_amounts: [{ amount: 0, tax_rate: 'txr_id_only' }] })] },
    });
    const result = normalizeInvoice('evt_1', 'invoice.paid', inv, makeCustomerMeta(), { txr_id_only: 'N3.6' });
    expect(result.lineItems[0].natura).toBe('N3.6');
    expect(result.lineItems[0].vatRate).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// normalizeInvoice — customer metadata extraction
// ---------------------------------------------------------------------------

describe('normalizeInvoice – customer metadata', () => {
  it('maps standard metadata keys to FiscalMetadata', () => {
    const result = normalizeInvoice('evt_1', 'invoice.paid', makeInvoice(), makeCustomerMeta());
    const c = result.customer;
    expect(c.vatNumber).toBe('00159560366');
    expect(c.sdiCode).toBe('0000000');
    expect(c.denominazione).toBe('ACME Srl');
    expect(c.nazione).toBe('IT');
  });

  it('accepts partita_iva as alias for vat_number', () => {
    const meta = makeCustomerMeta({ partita_iva: '00159560366' });
    delete meta['vat_number'];
    const result = normalizeInvoice('evt_1', 'invoice.paid', makeInvoice(), meta);
    expect(result.customer.vatNumber).toBe('00159560366');
  });

  it('invoice metadata overrides customer metadata', () => {
    const inv = makeInvoice({ metadata: { sdi_code: '1234567' } });
    const result = normalizeInvoice('evt_1', 'invoice.paid', inv, makeCustomerMeta({ sdi_code: '0000000' }));
    expect(result.customer.sdiCode).toBe('1234567');
  });

  it('defaults nazione to IT when absent', () => {
    const meta = makeCustomerMeta();
    delete meta['nazione'];
    const result = normalizeInvoice('evt_1', 'invoice.paid', makeInvoice(), meta);
    expect(result.customer.nazione).toBe('IT');
  });
});

// ---------------------------------------------------------------------------
// normalizeCharge — missing invoice throws deterministically
// ---------------------------------------------------------------------------

describe('normalizeCharge – missing invoice throws', () => {
  it('throws when invoice is missing', () => {
    expect(() =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (normalizeCharge as any)('evt_1', makeCharge(), makeCustomerMeta(), undefined),
    ).toThrow('StripeInvoice richiesto per nota di credito TD04');
  });

  it('standard-VAT refund cannot fall back to N4 without invoice', () => {
    const charge = makeCharge({ amount: 12200, amount_refunded: 12200 });
    expect(() =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (normalizeCharge as any)('evt_1', charge, makeCustomerMeta(), undefined),
    ).toThrow('StripeInvoice richiesto per nota di credito TD04');
  });
});

// ---------------------------------------------------------------------------
// normalizeCharge — stripeInvoiceId assignment
// ---------------------------------------------------------------------------

describe('normalizeCharge – stripeInvoiceId', () => {
  it('uses charge.invoice as stripeInvoiceId', () => {
    const result = normalizeCharge('evt_1', makeCharge({ invoice: 'in_original' }), makeCustomerMeta(), makeInvoice());
    expect(result.stripeInvoiceId).toBe('in_original');
  });

  it('uses charge.id when charge.invoice is null', () => {
    const result = normalizeCharge('evt_1', makeCharge({ invoice: null }), makeCustomerMeta(), makeInvoice());
    expect(result.stripeInvoiceId).toBe('ch_test_001');
  });
});

// ---------------------------------------------------------------------------
// normalizeCharge — TD04 with original invoice (Comment 1)
// ---------------------------------------------------------------------------

describe('normalizeCharge – with invoice (full refund)', () => {
  it('preserves original 22% VAT rate on full refund', () => {
    const inv = makeInvoice(); // 100 EUR taxable + 22 EUR VAT = 122 EUR
    const charge = makeCharge({ amount: 12200, amount_refunded: 12200 });
    const result = normalizeCharge('evt_1', charge, makeCustomerMeta(), inv);
    expect(result.tipoDocumento).toBe('TD04');
    expect(result.lineItems[0].vatRate).toBe(22);
    expect(result.lineItems[0].natura).toBeNull();
    expect(result.lineItems[0].taxableAmount).toBe(100.00);
    expect(result.lineItems[0].vatAmount).toBe(22.00);
    expect(result.totals.grand).toBe(122.00);
  });

  it('preserves N4 natura on full refund of exempt invoice', () => {
    const inv = makeInvoice({
      total: 10000,
      lines: { data: [makeLineItem({ amount: 10000, tax_amounts: [{ amount: 0, tax_rate: { id: 'txr_0', percentage: 0 } }] })] },
    });
    const charge = makeCharge({ amount: 10000, amount_refunded: 10000 });
    const result = normalizeCharge('evt_1', charge, makeCustomerMeta(), inv);
    expect(result.lineItems[0].vatRate).toBeNull();
    expect(result.lineItems[0].natura).toBe('N4');
    expect(result.totals.grand).toBe(100.00);
  });

  it('invoice metadata overrides customerMeta on credit note', () => {
    const inv = makeInvoice({ metadata: { sdi_code: '9999999' } });
    const charge = makeCharge({ amount: 12200, amount_refunded: 12200 });
    const result = normalizeCharge('evt_1', charge, makeCustomerMeta({ sdi_code: '0000000' }), inv);
    // invoice.metadata wins over customerMeta when charge.metadata is absent
    expect(result.customer.sdiCode).toBe('9999999');
  });

  it('charge.metadata overrides invoice.metadata overrides customerMeta', () => {
    const inv = makeInvoice({ metadata: { sdi_code: '9999999' } });
    const charge = makeCharge({ amount: 12200, amount_refunded: 12200, metadata: { sdi_code: 'AAAAAAA' } });
    const result = normalizeCharge('evt_1', charge, makeCustomerMeta({ sdi_code: '0000000' }), inv);
    expect(result.customer.sdiCode).toBe('AAAAAAA');
  });
});

describe('normalizeCharge – with invoice (partial refund)', () => {
  it('prorates taxable and VAT amounts for 50% refund', () => {
    const inv = makeInvoice(); // 100 taxable + 22 VAT = 122 EUR total
    const charge = makeCharge({ amount: 12200, amount_refunded: 6100 }); // 50%
    const result = normalizeCharge('evt_1', charge, makeCustomerMeta(), inv);
    expect(result.lineItems[0].vatRate).toBe(22);
    expect(result.lineItems[0].taxableAmount).toBe(50.00);
    expect(result.lineItems[0].vatAmount).toBe(11.00);
    expect(result.totals.grand).toBe(61.00);
  });

  it('grand total matches amount_refunded exactly after proration', () => {
    const inv = makeInvoice();
    // Odd refund amount that triggers rounding
    const charge = makeCharge({ amount: 12200, amount_refunded: 4067 }); // ~33.3%
    const result = normalizeCharge('evt_1', charge, makeCustomerMeta(), inv);
    expect(result.totals.grand).toBe(centsToEur(4067));
  });

  it('preserves original vatRate on partial refund lines', () => {
    const inv = makeInvoice();
    const charge = makeCharge({ amount: 12200, amount_refunded: 3050 }); // 25%
    const result = normalizeCharge('evt_1', charge, makeCustomerMeta(), inv);
    expect(result.lineItems[0].vatRate).toBe(22);
  });
});

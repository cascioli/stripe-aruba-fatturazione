import type { NaturaIva } from '../domain/types.js';

export interface TaxRateInfo {
  id: string;
  percentage: number;
  metadata?: Record<string, string>;
}

export interface NaturaResolution {
  vatRate: number | null;
  natura: NaturaIva | null;
}

/**
 * Resolves a Stripe TaxRate to either a numeric VAT rate or an Italian Natura IVA code.
 *
 * Priority:
 *   1. customMap keyed by Tax Rate ID (runtime override)
 *   2. metadata.natura_iva on the Tax Rate object (Stripe-side config)
 *   3. percentage === 0 → N4 (esente) by default
 *   4. percentage > 0 → standard rated (vatRate = percentage)
 */
export function resolveNaturaIva(
  taxRate: TaxRateInfo,
  customMap: Record<string, NaturaIva> = {},
): NaturaResolution {
  if (customMap[taxRate.id]) {
    return { vatRate: null, natura: customMap[taxRate.id] };
  }

  const metaNatura = taxRate.metadata?.['natura_iva'] as NaturaIva | undefined;
  if (metaNatura) {
    return { vatRate: null, natura: metaNatura };
  }

  if (taxRate.percentage === 0) {
    return { vatRate: null, natura: 'N4' };
  }

  return { vatRate: taxRate.percentage, natura: null };
}

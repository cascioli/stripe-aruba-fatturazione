export enum JobStatus {
  PENDING = 'PENDING',
  CREATED_DRAFT = 'CREATED_DRAFT',
  SENT_SDI = 'SENT_SDI',
  FAILED_VALIDATION = 'FAILED_VALIDATION',
  ERROR = 'ERROR',
}

export type EventType = 'invoice.paid' | 'charge.refunded' | 'invoice.voided';

export type TipoDocumento = 'TD01' | 'TD04';

export type NaturaIva =
  | 'N1'
  | 'N2.1' | 'N2.2'
  | 'N3.1' | 'N3.2' | 'N3.3' | 'N3.4' | 'N3.5' | 'N3.6'
  | 'N4' | 'N5'
  | 'N6.1' | 'N6.2' | 'N6.3' | 'N6.4' | 'N6.5' | 'N6.6' | 'N6.7' | 'N6.8' | 'N6.9'
  | 'N7';

export interface FiscalMetadata {
  // Partita IVA o Codice Fiscale
  vatNumber?: string;
  codiceFiscale?: string;

  // Canale SDI (codice destinatario o PEC)
  sdiCode?: string;
  pec?: string;

  // Anagrafica: persona giuridica
  denominazione?: string;

  // Anagrafica: persona fisica
  nome?: string;
  cognome?: string;

  // Indirizzo
  indirizzo: string;
  cap: string;
  comune: string;
  provincia: string;
  nazione: string;
}

export interface FiscalLineItem {
  description: string;
  quantity: number;
  unitPrice: number;      // EUR, 2 decimal places
  vatRate: number | null; // null when natura applies
  natura: NaturaIva | null;
  taxableAmount: number;  // EUR, 2 decimal places
  vatAmount: number;      // EUR, 2 decimal places
}

export interface FiscalTotals {
  taxable: number;
  vat: number;
  grand: number;
}

export interface FiscalInvoice {
  stripeInvoiceId: string;
  stripeEventId: string;
  tipoDocumento: TipoDocumento;
  number: string;
  date: Date;
  currency: string;
  customer: FiscalMetadata;
  lineItems: FiscalLineItem[];
  totals: FiscalTotals;
  notes?: string;
}

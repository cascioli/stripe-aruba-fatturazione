export enum JobStatus {
  PENDING = 'PENDING',
  CREATED_DRAFT = 'CREATED_DRAFT',
  SENT_SDI = 'SENT_SDI',
  FAILED_VALIDATION = 'FAILED_VALIDATION',
  ERROR = 'ERROR',
}

export type EventType = 'invoice.paid' | 'charge.refunded' | 'invoice.voided';

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

export interface NormalizedLineItem {
  description: string;
  quantity: number;
  unitPrice: number;    // centesimi
  vatRate: number;      // es. 22 per 22%
  total: number;        // centesimi
}

export interface NormalizedInvoice {
  stripeInvoiceId: string;
  stripeEventId: string;
  eventType: EventType;
  number: string;
  date: Date;
  currency: string;
  totalAmountCents: number;
  customer: FiscalMetadata;
  lineItems: NormalizedLineItem[];
  notes?: string;
}

import type { FiscalInvoice, FiscalLineItem, NaturaIva, TipoDocumento } from '../domain/types.js';

export interface CedenteConfig {
  partitaIva: string;
  denominazione: string;
  indirizzo: string;
  cap: string;
  comune: string;
  provincia: string;
  nazione: string;
  regimeFiscale: string;
}

export interface DatiRiepilogo {
  aliquotaIVA: number;
  natura?: NaturaIva;
  imponibileImporto: number;
  imposta: number;
}

export interface ArubaInvoicePayload {
  datiTrasmissione: {
    progressivoInvio: string;
    codiceDestinatario: string;
    pecDestinatario?: string;
  };
  cedentePrestatore: {
    idPaese: string;
    idCodice: string;
    denominazione: string;
    indirizzo: string;
    cap: string;
    comune: string;
    provincia: string;
    nazione: string;
    regimeFiscale: string;
  };
  cessionarioCommittente: {
    idPaese?: string;
    idCodice?: string;
    codiceFiscale?: string;
    denominazione?: string;
    nome?: string;
    cognome?: string;
    indirizzo: string;
    cap: string;
    comune: string;
    provincia: string;
    nazione: string;
  };
  datiGenerali: {
    tipoDocumento: TipoDocumento;
    divisa: string;
    data: string;
    numero: string;
  };
  dettaglioLinee: Array<{
    numeroLinea: number;
    descrizione: string;
    quantita: number;
    prezzoUnitario: number;
    prezzoTotale: number;
    aliquotaIVA: number;
    natura?: NaturaIva;
  }>;
  datiRiepilogo: DatiRiepilogo[];
}

export interface ArubaUploadEnvelope {
  dataFile: string; // base64-encoded FatturaPA XML
  credential: string;
  domain: string;
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function buildFatturaPAXml(payload: ArubaInvoicePayload): string {
  const { datiTrasmissione: dt, cedentePrestatore: cp, cessionarioCommittente: cc,
          datiGenerali: dg, dettaglioLinee: dl, datiRiepilogo: dr } = payload;

  const pecTag = dt.pecDestinatario
    ? `<PECDestinatario>${escapeXml(dt.pecDestinatario)}</PECDestinatario>`
    : '';

  const committentIdTag = cc.idCodice
    ? `<IdFiscaleIVA><IdPaese>${escapeXml(cc.idPaese ?? 'IT')}</IdPaese><IdCodice>${escapeXml(cc.idCodice)}</IdCodice></IdFiscaleIVA>`
    : '';

  const committentCfTag = cc.codiceFiscale
    ? `<CodiceFiscale>${escapeXml(cc.codiceFiscale)}</CodiceFiscale>`
    : '';

  const committentNameTag = cc.denominazione
    ? `<Denominazione>${escapeXml(cc.denominazione)}</Denominazione>`
    : cc.nome && cc.cognome
      ? `<Nome>${escapeXml(cc.nome)}</Nome><Cognome>${escapeXml(cc.cognome)}</Cognome>`
      : '';

  const lineeXml = dl.map((l) => `
      <DettaglioLinee>
        <NumeroLinea>${l.numeroLinea}</NumeroLinea>
        <Descrizione>${escapeXml(l.descrizione)}</Descrizione>
        <Quantita>${l.quantita.toFixed(2)}</Quantita>
        <PrezzoUnitario>${l.prezzoUnitario.toFixed(2)}</PrezzoUnitario>
        <PrezzoTotale>${l.prezzoTotale.toFixed(2)}</PrezzoTotale>
        <AliquotaIVA>${l.aliquotaIVA.toFixed(2)}</AliquotaIVA>
        ${l.natura ? `<Natura>${escapeXml(l.natura)}</Natura>` : ''}
      </DettaglioLinee>`).join('');

  const riepilogoXml = dr.map((r) => `
      <DatiRiepilogo>
        <AliquotaIVA>${r.aliquotaIVA.toFixed(2)}</AliquotaIVA>
        ${r.natura ? `<Natura>${escapeXml(r.natura)}</Natura>` : ''}
        <ImponibileImporto>${r.imponibileImporto.toFixed(2)}</ImponibileImporto>
        <Imposta>${r.imposta.toFixed(2)}</Imposta>
        <EsigibilitaIVA>I</EsigibilitaIVA>
      </DatiRiepilogo>`).join('');

  return `<?xml version="1.0" encoding="UTF-8"?>
<p:FatturaElettronica versione="FPR12" xmlns:p="http://ivaservizi.agenziaentrate.gov.it/docs/xsd/fatture/v1.2">
  <FatturaElettronicaHeader>
    <DatiTrasmissione>
      <IdTrasmittente>
        <IdPaese>${escapeXml(cp.idPaese)}</IdPaese>
        <IdCodice>${escapeXml(cp.idCodice)}</IdCodice>
      </IdTrasmittente>
      <ProgressivoInvio>${escapeXml(dt.progressivoInvio)}</ProgressivoInvio>
      <FormatoTrasmissione>FPR12</FormatoTrasmissione>
      <CodiceDestinatario>${escapeXml(dt.codiceDestinatario)}</CodiceDestinatario>
      ${pecTag}
    </DatiTrasmissione>
    <CedentePrestatore>
      <DatiAnagrafici>
        <IdFiscaleIVA>
          <IdPaese>${escapeXml(cp.idPaese)}</IdPaese>
          <IdCodice>${escapeXml(cp.idCodice)}</IdCodice>
        </IdFiscaleIVA>
        <Anagrafica>
          <Denominazione>${escapeXml(cp.denominazione)}</Denominazione>
        </Anagrafica>
        <RegimeFiscale>${escapeXml(cp.regimeFiscale)}</RegimeFiscale>
      </DatiAnagrafici>
      <Sede>
        <Indirizzo>${escapeXml(cp.indirizzo)}</Indirizzo>
        <CAP>${escapeXml(cp.cap)}</CAP>
        <Comune>${escapeXml(cp.comune)}</Comune>
        <Provincia>${escapeXml(cp.provincia)}</Provincia>
        <Nazione>${escapeXml(cp.nazione)}</Nazione>
      </Sede>
    </CedentePrestatore>
    <CessionarioCommittente>
      <DatiAnagrafici>
        ${committentIdTag}
        ${committentCfTag}
        <Anagrafica>${committentNameTag}</Anagrafica>
      </DatiAnagrafici>
      <Sede>
        <Indirizzo>${escapeXml(cc.indirizzo)}</Indirizzo>
        <CAP>${escapeXml(cc.cap)}</CAP>
        <Comune>${escapeXml(cc.comune)}</Comune>
        <Provincia>${escapeXml(cc.provincia)}</Provincia>
        <Nazione>${escapeXml(cc.nazione)}</Nazione>
      </Sede>
    </CessionarioCommittente>
  </FatturaElettronicaHeader>
  <FatturaElettronicaBody>
    <DatiGenerali>
      <DatiGeneraliDocumento>
        <TipoDocumento>${escapeXml(dg.tipoDocumento)}</TipoDocumento>
        <Divisa>${escapeXml(dg.divisa)}</Divisa>
        <Data>${escapeXml(dg.data)}</Data>
        <Numero>${escapeXml(dg.numero)}</Numero>
      </DatiGeneraliDocumento>
    </DatiGenerali>
    <DatiBeniServizi>${lineeXml}${riepilogoXml}
    </DatiBeniServizi>
  </FatturaElettronicaBody>
</p:FatturaElettronica>`;
}

export function buildUploadEnvelope(payload: ArubaInvoicePayload): ArubaUploadEnvelope {
  const xml = buildFatturaPAXml(payload);
  const dataFile = Buffer.from(xml, 'utf-8').toString('base64');
  return { dataFile, credential: '', domain: '' };
}

function formatDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function sanitizeProgressivo(number: string): string {
  const cleaned = number.replace(/[^A-Z0-9]/gi, '').toUpperCase();
  return cleaned.slice(-10) || '00001';
}

function halfUp(v: number): number {
  return Math.round((v + Number.EPSILON) * 100) / 100;
}

function groupByAliquota(items: FiscalLineItem[]): DatiRiepilogo[] {
  const groups = new Map<string, DatiRiepilogo>();
  for (const item of items) {
    const key = item.natura ?? String(item.vatRate);
    const existing = groups.get(key);
    if (existing) {
      existing.imponibileImporto = halfUp(existing.imponibileImporto + item.taxableAmount);
      existing.imposta = halfUp(existing.imposta + item.vatAmount);
    } else {
      const entry: DatiRiepilogo = {
        aliquotaIVA: item.vatRate ?? 0,
        imponibileImporto: item.taxableAmount,
        imposta: item.vatAmount,
      };
      if (item.natura) entry.natura = item.natura;
      groups.set(key, entry);
    }
  }
  return Array.from(groups.values());
}

export function buildInvoicePayload(
  invoice: FiscalInvoice,
  cedente: CedenteConfig,
): ArubaInvoicePayload {
  const { customer } = invoice;
  const codiceDestinatario = customer.sdiCode ?? '0000000';
  const pecDestinatario = !customer.sdiCode && customer.pec ? customer.pec : undefined;

  return {
    datiTrasmissione: {
      progressivoInvio: sanitizeProgressivo(invoice.number),
      codiceDestinatario,
      ...(pecDestinatario ? { pecDestinatario } : {}),
    },
    cedentePrestatore: {
      idPaese: cedente.nazione,
      idCodice: cedente.partitaIva,
      denominazione: cedente.denominazione,
      indirizzo: cedente.indirizzo,
      cap: cedente.cap,
      comune: cedente.comune,
      provincia: cedente.provincia,
      nazione: cedente.nazione,
      regimeFiscale: cedente.regimeFiscale,
    },
    cessionarioCommittente: {
      ...(customer.vatNumber ? { idPaese: customer.nazione, idCodice: customer.vatNumber } : {}),
      ...(customer.codiceFiscale ? { codiceFiscale: customer.codiceFiscale } : {}),
      ...(customer.denominazione ? { denominazione: customer.denominazione } : {}),
      ...(customer.nome ? { nome: customer.nome } : {}),
      ...(customer.cognome ? { cognome: customer.cognome } : {}),
      indirizzo: customer.indirizzo,
      cap: customer.cap,
      comune: customer.comune,
      provincia: customer.provincia,
      nazione: customer.nazione,
    },
    datiGenerali: {
      tipoDocumento: invoice.tipoDocumento,
      divisa: invoice.currency,
      data: formatDate(invoice.date),
      numero: invoice.number,
    },
    dettaglioLinee: invoice.lineItems.map((item, idx) => ({
      numeroLinea: idx + 1,
      descrizione: item.description,
      quantita: item.quantity,
      prezzoUnitario: item.unitPrice,
      prezzoTotale: item.taxableAmount,
      aliquotaIVA: item.vatRate ?? 0,
      ...(item.natura ? { natura: item.natura } : {}),
    })),
    datiRiepilogo: groupByAliquota(invoice.lineItems),
  };
}

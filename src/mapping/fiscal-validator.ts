import type { FiscalMetadata } from '../domain/types.js';

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

// ISO 3166-1 alpha-2 codes accepted by SdI; rejects invented codes such as XX
const SUPPORTED_NAZIONI = new Set<string>([
  'AF','AX','AL','DZ','AS','AD','AO','AI','AQ','AG','AR','AM','AW','AU','AT',
  'AZ','BS','BH','BD','BB','BY','BE','BZ','BJ','BM','BT','BO','BQ','BA','BW',
  'BV','BR','IO','BN','BG','BF','BI','CV','KH','CM','CA','KY','CF','TD','CL',
  'CN','CX','CC','CO','KM','CG','CD','CK','CR','CI','HR','CU','CW','CY','CZ',
  'DK','DJ','DM','DO','EC','EG','SV','GQ','ER','EE','SZ','ET','FK','FO','FJ',
  'FI','FR','GF','PF','TF','GA','GM','GE','DE','GH','GI','GR','GL','GD','GP',
  'GU','GT','GG','GN','GW','GY','HT','HM','VA','HN','HK','HU','IS','IN','ID',
  'IR','IQ','IE','IM','IL','IT','JM','JP','JE','JO','KZ','KE','KI','KP','KR',
  'KW','KG','LA','LV','LB','LS','LR','LY','LI','LT','LU','MO','MG','MW','MY',
  'MV','ML','MT','MH','MQ','MR','MU','YT','MX','FM','MD','MC','MN','ME','MS',
  'MA','MZ','MM','NA','NR','NP','NL','NC','NZ','NI','NE','NG','NU','NF','MK',
  'MP','NO','OM','PK','PW','PS','PA','PG','PY','PE','PH','PN','PL','PT','PR',
  'QA','RE','RO','RU','RW','BL','SH','KN','LC','MF','PM','VC','WS','SM','ST',
  'SA','SN','RS','SC','SL','SG','SX','SK','SI','SB','SO','ZA','GS','SS','ES',
  'LK','SD','SR','SJ','SE','CH','SY','TW','TJ','TZ','TH','TL','TG','TK','TO',
  'TT','TN','TR','TM','TC','TV','UG','UA','AE','GB','US','UM','UY','UZ','VU',
  'VE','VN','VG','VI','WF','EH','YE','ZM','ZW',
]);

// Lookup tables for Codice Fiscale check-character algorithm
const CF_ODD: Record<string, number> = {
  '0': 1, '1': 0, '2': 5, '3': 7, '4': 9, '5': 13, '6': 15, '7': 17, '8': 19, '9': 21,
  A: 1,  B: 0,  C: 5,  D: 7,  E: 9,  F: 13, G: 15, H: 17, I: 19, J: 21,
  K: 2,  L: 4,  M: 18, N: 20, O: 11, P: 3,  Q: 6,  R: 8,  S: 12, T: 14,
  U: 16, V: 10, W: 22, X: 25, Y: 24, Z: 23,
};

const CF_EVEN: Record<string, number> = {
  '0': 0, '1': 1, '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7, '8': 8, '9': 9,
  A: 0,  B: 1,  C: 2,  D: 3,  E: 4,  F: 5,  G: 6,  H: 7,  I: 8,  J: 9,
  K: 10, L: 11, M: 12, N: 13, O: 14, P: 15, Q: 16, R: 17, S: 18, T: 19,
  U: 20, V: 21, W: 22, X: 23, Y: 24, Z: 25,
};

// Formal Italian CF layout: 6 alpha (surname+name), 2 alphanum (year), 1 month-letter,
// 2 alphanum (day+sex), 1 alpha (municipality prefix), 3 alphanum (cadastral), 1 alpha (check)
const CF_REGEX = /^[A-Z]{6}[0-9LMNPQRSTUV]{2}[ABCDEHLMPRST][0-9LMNPQRSTUV]{2}[A-Z][0-9LMNPQRSTUV]{3}[A-Z]$/;

// Homocodia: letters substituted for digits in numeric CF positions (L=0 … V=9)
const HOMOCODIA_DECODE: Record<string, number> = {
  L: 0, M: 1, N: 2, P: 3, Q: 4, R: 5, S: 6, T: 7, U: 8, V: 9,
};

function decodeHomocodiaDigit(ch: string): number {
  if (ch >= '0' && ch <= '9') return parseInt(ch, 10);
  return HOMOCODIA_DECODE[ch] ?? -1;
}

function isValidItalianVAT(raw: string): boolean {
  const vat = raw.trim().replace(/^IT/i, '');
  if (!/^\d{11}$/.test(vat)) return false;

  let sum = 0;
  for (let i = 0; i < 10; i++) {
    const d = parseInt(vat[i], 10);
    if (i % 2 === 0) {
      sum += d;
    } else {
      const doubled = d * 2;
      sum += doubled >= 10 ? doubled - 9 : doubled;
    }
  }
  return (10 - (sum % 10)) % 10 === parseInt(vat[10], 10);
}

function isValidCodiceFiscale(cf: string): boolean {
  const upper = cf.trim().toUpperCase();
  // Formal layout check before checksum
  if (!CF_REGEX.test(upper)) return false;

  // Checksum
  let sum = 0;
  for (let i = 0; i < 15; i++) {
    const ch = upper[i];
    sum += i % 2 === 0 ? (CF_ODD[ch] ?? 0) : (CF_EVEN[ch] ?? 0);
  }
  if (upper[15] !== String.fromCharCode(65 + (sum % 26))) return false;

  // Decode homocodia and validate day/sex range (positions 9-10)
  // Male: decoded day 01-31; Female: decoded day 41-71 (day + 40)
  const d9 = decodeHomocodiaDigit(upper[9]);
  const d10 = decodeHomocodiaDigit(upper[10]);
  if (d9 < 0 || d10 < 0) return false;
  const day = d9 * 10 + d10;
  return (day >= 1 && day <= 31) || (day >= 41 && day <= 71);
}

function isValidPec(pec: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(pec.trim());
}

/**
 * Validates fiscal metadata for Italian e-invoicing (FatturaPA).
 * Never throws — returns a ValidationResult with all errors listed.
 */
export function validateFiscalData(meta: FiscalMetadata): ValidationResult {
  const errors: string[] = [];

  if (!meta.vatNumber && !meta.codiceFiscale) {
    errors.push('Partita IVA o Codice Fiscale obbligatorio');
  }

  if (meta.vatNumber && !isValidItalianVAT(meta.vatNumber)) {
    errors.push('Partita IVA non valida');
  }

  if (meta.codiceFiscale && !isValidCodiceFiscale(meta.codiceFiscale)) {
    errors.push('Codice Fiscale non valido');
  }

  // sdiCode must be exactly 7 alphanumeric characters (trimmed)
  const sdiCode = typeof meta.sdiCode === 'string' ? meta.sdiCode.trim() : undefined;
  const hasSdi = typeof sdiCode === 'string' && /^[A-Z0-9]{7}$/i.test(sdiCode);
  const hasPec = typeof meta.pec === 'string' && isValidPec(meta.pec);
  if (!hasSdi && !hasPec) {
    errors.push('Codice Destinatario a 7 caratteri oppure PEC valida obbligatoria');
  }

  if (!meta.denominazione && (!meta.nome || !meta.cognome)) {
    errors.push('Denominazione oppure Nome e Cognome obbligatori');
  }

  if (!meta.indirizzo?.trim()) errors.push('Indirizzo obbligatorio');
  if (!meta.comune?.trim()) errors.push('Comune obbligatorio');

  const nazione = meta.nazione?.trim().toUpperCase();
  if (!nazione) {
    errors.push('Nazione obbligatoria');
  } else if (!/^[A-Z]{2}$/.test(nazione)) {
    errors.push('Nazione non valida (deve essere codice ISO 3166-1 alpha-2 di 2 lettere)');
  } else if (!SUPPORTED_NAZIONI.has(nazione)) {
    errors.push('Nazione non supportata (codice ISO 3166-1 alpha-2 non riconosciuto)');
  }

  if (!meta.cap?.trim()) {
    errors.push('CAP obbligatorio');
  } else if (nazione === 'IT' && !/^\d{5}$/.test(meta.cap.trim())) {
    errors.push('CAP non valido (deve essere 5 cifre per IT)');
  }

  if (nazione === 'IT' && !meta.provincia?.trim()) {
    errors.push('Provincia obbligatoria per indirizzi italiani');
  } else if (meta.provincia?.trim() && !/^[A-Za-z]{2}$/.test(meta.provincia.trim())) {
    errors.push('Provincia non valida (deve essere sigla di 2 lettere)');
  }

  return { valid: errors.length === 0, errors };
}

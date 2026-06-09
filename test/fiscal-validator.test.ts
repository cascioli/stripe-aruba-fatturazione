import { describe, it, expect } from 'vitest';
import { validateFiscalData } from '../src/mapping/fiscal-validator.js';
import type { FiscalMetadata } from '../src/domain/types.js';

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

function validMeta(overrides: Partial<FiscalMetadata> = {}): FiscalMetadata {
  return {
    vatNumber: '00159560366',
    sdiCode: '0000000',
    denominazione: 'ACME Srl',
    indirizzo: 'Via Roma 1',
    cap: '40100',
    comune: 'Bologna',
    provincia: 'BO',
    nazione: 'IT',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe('validateFiscalData – valid input', () => {
  it('returns valid=true with no errors for correct data', () => {
    const result = validateFiscalData(validMeta());
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('accepts IT-prefixed Partita IVA', () => {
    const result = validateFiscalData(validMeta({ vatNumber: 'IT00159560366' }));
    expect(result.valid).toBe(true);
  });

  it('accepts lowercase IT prefix', () => {
    const result = validateFiscalData(validMeta({ vatNumber: 'it00159560366' }));
    expect(result.valid).toBe(true);
  });

  it('accepts valid Codice Fiscale', () => {
    // RSSMRA85T10A562S — Mario Rossi
    const result = validateFiscalData(validMeta({ vatNumber: undefined, codiceFiscale: 'RSSMRA85T10A562S' }));
    expect(result.valid).toBe(true);
  });

  it('accepts PEC in place of SDI code', () => {
    const result = validateFiscalData(validMeta({ sdiCode: undefined, pec: 'azienda@pec.it' }));
    expect(result.valid).toBe(true);
  });

  it('accepts both SDI code and PEC', () => {
    const result = validateFiscalData(validMeta({ pec: 'azienda@pec.it' }));
    expect(result.valid).toBe(true);
  });

  it('accepts nome+cognome in place of denominazione', () => {
    const result = validateFiscalData(
      validMeta({ denominazione: undefined, nome: 'Mario', cognome: 'Rossi' }),
    );
    expect(result.valid).toBe(true);
  });

  it('accepts non-IT nazione and skips CAP format check', () => {
    // No provincia required for non-IT
    const result = validateFiscalData(validMeta({ nazione: 'DE', cap: '10115', provincia: undefined }));
    expect(result.valid).toBe(true);
  });

  it('exactly 7 alphanumeric chars sdiCode passes', () => {
    const result = validateFiscalData(validMeta({ sdiCode: 'ABC1234' }));
    expect(result.valid).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Partita IVA errors
// ---------------------------------------------------------------------------

describe('validateFiscalData – Partita IVA', () => {
  it('reports error for invalid checksum', () => {
    const result = validateFiscalData(validMeta({ vatNumber: '00159560360' })); // wrong check digit
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('Partita IVA non valida');
  });

  it('reports error for wrong length', () => {
    const result = validateFiscalData(validMeta({ vatNumber: '1234567890' })); // 10 digits
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('Partita IVA non valida');
  });

  it('reports error when both vatNumber and codiceFiscale are absent', () => {
    const result = validateFiscalData(validMeta({ vatNumber: undefined, codiceFiscale: undefined }));
    expect(result.errors).toContain('Partita IVA o Codice Fiscale obbligatorio');
  });
});

// ---------------------------------------------------------------------------
// Codice Fiscale errors
// ---------------------------------------------------------------------------

describe('validateFiscalData – Codice Fiscale', () => {
  it('reports error for wrong check character', () => {
    const result = validateFiscalData(validMeta({ vatNumber: undefined, codiceFiscale: 'RSSMRA85T10A562X' }));
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('Codice Fiscale non valido');
  });

  it('reports error for wrong length', () => {
    const result = validateFiscalData(validMeta({ vatNumber: undefined, codiceFiscale: 'RSSMRA85' }));
    expect(result.errors).toContain('Codice Fiscale non valido');
  });

  it('rejects structurally invalid CF even if checksum accidentally matches', () => {
    // All digits — fails CF_REGEX layout check regardless of checksum
    const result = validateFiscalData(validMeta({ vatNumber: undefined, codiceFiscale: '0000000000000000' }));
    expect(result.errors).toContain('Codice Fiscale non valido');
  });

  it('rejects CF with wrong month-letter position', () => {
    // Position 8 (0-indexed) must be one of ABCDEHLMPRST — use 'Z' to break it
    // RSSMRA85Z10A562S — Z is not a valid month code
    const result = validateFiscalData(validMeta({ vatNumber: undefined, codiceFiscale: 'RSSMRA85Z10A562S' }));
    expect(result.errors).toContain('Codice Fiscale non valido');
  });

  it('rejects checksum-correct CF with impossible day 99 (RSSMRA85T99A562U)', () => {
    // Checksum is valid but decoded day=99 is outside both male (01-31) and female (41-71) ranges
    const result = validateFiscalData(validMeta({ vatNumber: undefined, codiceFiscale: 'RSSMRA85T99A562U' }));
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('Codice Fiscale non valido');
  });

  it('accepts CF with valid male day 10 (RSSMRA85T10A562S)', () => {
    const result = validateFiscalData(validMeta({ vatNumber: undefined, codiceFiscale: 'RSSMRA85T10A562S' }));
    expect(result.valid).toBe(true);
    expect(result.errors).not.toContain('Codice Fiscale non valido');
  });
});

// ---------------------------------------------------------------------------
// SDI / PEC (alternative rule)
// ---------------------------------------------------------------------------

describe('validateFiscalData – SDI / PEC', () => {
  it('reports error when both sdiCode and pec are absent', () => {
    const result = validateFiscalData(validMeta({ sdiCode: undefined, pec: undefined }));
    expect(result.errors).toContain('Codice Destinatario a 7 caratteri oppure PEC valida obbligatoria');
  });

  it('reports error when sdiCode has wrong length (not 7)', () => {
    const result = validateFiscalData(validMeta({ sdiCode: '123456', pec: undefined })); // 6 chars
    expect(result.errors).toContain('Codice Destinatario a 7 caratteri oppure PEC valida obbligatoria');
  });

  it('reports error for malformed PEC', () => {
    const result = validateFiscalData(validMeta({ sdiCode: undefined, pec: 'notanemail' }));
    expect(result.errors).toContain('Codice Destinatario a 7 caratteri oppure PEC valida obbligatoria');
  });

  it('rejects sdiCode of 7 spaces (whitespace-only)', () => {
    const result = validateFiscalData(validMeta({ sdiCode: '       ', pec: undefined }));
    expect(result.errors).toContain('Codice Destinatario a 7 caratteri oppure PEC valida obbligatoria');
  });

  it('rejects sdiCode with non-alphanumeric chars', () => {
    const result = validateFiscalData(validMeta({ sdiCode: '!!!!!!!' }));
    expect(result.errors).toContain('Codice Destinatario a 7 caratteri oppure PEC valida obbligatoria');
  });
});

// ---------------------------------------------------------------------------
// Nazione validation (Comment 5)
// ---------------------------------------------------------------------------

describe('validateFiscalData – nazione', () => {
  it('accepts valid 2-letter country codes', () => {
    const result = validateFiscalData(validMeta({ nazione: 'DE', cap: '10115', provincia: undefined }));
    expect(result.errors).not.toContain('Nazione non valida (deve essere codice ISO 3166-1 alpha-2 di 2 lettere)');
  });

  it('rejects 3-letter country codes', () => {
    const result = validateFiscalData(validMeta({ nazione: 'DEU', cap: '10115' }));
    expect(result.errors).toContain('Nazione non valida (deve essere codice ISO 3166-1 alpha-2 di 2 lettere)');
  });

  it('rejects numeric country codes', () => {
    const result = validateFiscalData(validMeta({ nazione: '39', cap: '40100' }));
    expect(result.errors).toContain('Nazione non valida (deve essere codice ISO 3166-1 alpha-2 di 2 lettere)');
  });

  it('rejects unsupported two-letter country code XX', () => {
    const result = validateFiscalData(validMeta({ nazione: 'XX', cap: '10115', provincia: undefined }));
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('Nazione non supportata (codice ISO 3166-1 alpha-2 non riconosciuto)');
  });

  it('accepts IT as supported nazione', () => {
    const result = validateFiscalData(validMeta());
    expect(result.errors).not.toContain('Nazione non supportata (codice ISO 3166-1 alpha-2 non riconosciuto)');
  });

  it('accepts US as supported nazione', () => {
    const result = validateFiscalData(validMeta({ nazione: 'US', cap: '10001', provincia: undefined }));
    expect(result.errors).not.toContain('Nazione non supportata (codice ISO 3166-1 alpha-2 non riconosciuto)');
  });
});

// ---------------------------------------------------------------------------
// Provincia required for IT (Comment 5)
// ---------------------------------------------------------------------------

describe('validateFiscalData – provincia for IT', () => {
  it('requires provincia for Italian addresses', () => {
    const result = validateFiscalData(validMeta({ provincia: undefined }));
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('Provincia obbligatoria per indirizzi italiani');
  });

  it('does not require provincia for non-IT addresses', () => {
    const result = validateFiscalData(validMeta({ nazione: 'DE', cap: '10115', provincia: undefined }));
    expect(result.errors).not.toContain('Provincia obbligatoria per indirizzi italiani');
  });

  it('still validates provincia format when provided for non-IT', () => {
    const result = validateFiscalData(validMeta({ nazione: 'DE', cap: '10115', provincia: 'BER' }));
    expect(result.errors).toContain('Provincia non valida (deve essere sigla di 2 lettere)');
  });

  it('reports error for invalid provincia sigla', () => {
    const result = validateFiscalData(validMeta({ provincia: 'BOL' })); // 3 chars
    expect(result.errors).toContain('Provincia non valida (deve essere sigla di 2 lettere)');
  });
});

// ---------------------------------------------------------------------------
// Address / anagrafica errors
// ---------------------------------------------------------------------------

describe('validateFiscalData – address fields', () => {
  it('reports error when both denominazione and nome/cognome absent', () => {
    const result = validateFiscalData(validMeta({ denominazione: undefined, nome: undefined, cognome: undefined }));
    expect(result.errors).toContain('Denominazione oppure Nome e Cognome obbligatori');
  });

  it('reports error for missing nome when cognome is present but denominazione absent', () => {
    const result = validateFiscalData(validMeta({ denominazione: undefined, cognome: 'Rossi' }));
    expect(result.errors).toContain('Denominazione oppure Nome e Cognome obbligatori');
  });

  it('reports error for missing indirizzo', () => {
    const result = validateFiscalData(validMeta({ indirizzo: '' }));
    expect(result.errors).toContain('Indirizzo obbligatorio');
  });

  it('reports error for missing comune', () => {
    const result = validateFiscalData(validMeta({ comune: '' }));
    expect(result.errors).toContain('Comune obbligatorio');
  });

  it('reports error for missing nazione', () => {
    const result = validateFiscalData(validMeta({ nazione: '' }));
    expect(result.errors).toContain('Nazione obbligatoria');
  });

  it('reports error for missing CAP', () => {
    const result = validateFiscalData(validMeta({ cap: '' }));
    expect(result.errors).toContain('CAP obbligatorio');
  });

  it('reports error for invalid IT CAP (not 5 digits)', () => {
    const result = validateFiscalData(validMeta({ cap: 'ABC12' }));
    expect(result.errors).toContain('CAP non valido (deve essere 5 cifre per IT)');
  });
});

// ---------------------------------------------------------------------------
// Multiple errors in one call
// ---------------------------------------------------------------------------

describe('validateFiscalData – multiple errors', () => {
  it('collects all errors without throwing', () => {
    const result = validateFiscalData({
      indirizzo: '',
      cap: '',
      comune: '',
      provincia: '',
      nazione: '',
    });
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(3);
  });

  it('never throws', () => {
    expect(() => validateFiscalData({} as FiscalMetadata)).not.toThrow();
  });
});

# Stripe Setup Guide

## 1. Dashboard UI

### 1.1 Creare l'endpoint webhook

1. Accedi a [dashboard.stripe.com](https://dashboard.stripe.com) → **Developers → Webhooks**.
2. Clicca **+ Add endpoint**.
3. Inserisci l'URL del tuo server: `https://your-domain.com/webhook`.
4. In **Events to send** seleziona i tre eventi gestiti:

   | Evento | Quando scatta |
   |---|---|
   | `invoice.paid` | Fattura pagata → genera TD01 |
   | `charge.refunded` | Addebito rimborsato → genera TD04 |
   | `invoice.voided` | Fattura annullata → genera TD04 |

5. Clicca **Add endpoint**.

### 1.2 Recuperare il Signing Secret

Dopo aver creato l'endpoint, clicca su di esso → sezione **Signing secret** → **Reveal**.

Copia il valore (inizia con `whsec_...`) e impostalo come:

```
STRIPE_WEBHOOK_SECRET=whsec_...
```

> Ogni endpoint ha il proprio signing secret. Non riutilizzare lo stesso secret tra ambienti diversi.

### 1.3 Differenza tra chiavi `sk_test_` e `sk_live_`

| Chiave | Ambiente | Dati | Addebiti reali |
|---|---|---|---|
| `sk_test_...` | Test (DEMO) | Fittizi, nessun addebito | No |
| `sk_live_...` | Produzione | Reali | Sì |

**Regola di sicurezza applicata al boot (bidirezionale):** il server verifica che la chiave Stripe corrisponda all'ambiente Aruba configurato in entrambe le direzioni.

| `ARUBA_ENV` | `STRIPE_SECRET_KEY` richiesta | Comportamento se errata |
|---|---|---|
| `DEMO` | deve iniziare con `sk_test_` | avvio fallisce |
| `PROD` | deve iniziare con `sk_live_` | avvio fallisce |

Questo impedisce sia di inviare fatture reali all'ambiente demo Aruba, sia di creare documenti fiscali reali tramite eventi di test Stripe.

In aggiunta, ogni webhook ricevuto viene validato in tempo reale: il flag `livemode` dell'evento Stripe deve corrispondere ad `ARUBA_ENV`. Eventuali mismatch vengono ignorati silenziosamente con `200` — nessun job viene creato.

```
STRIPE_SECRET_KEY=sk_test_...   # DEMO (obbligatorio)
STRIPE_SECRET_KEY=sk_live_...   # PROD (obbligatorio)
```

### 1.4 Metadati fiscali sul Customer

I dati fiscali del destinatario della fattura vengono letti dai **metadata del Customer Stripe**. Imposta tutti i campi obbligatori su ciascun cliente prima che arrivi il primo pagamento — un campo mancante porta il job in `FAILED_VALIDATION`.

#### Campi supportati

| Chiave metadata | Req. | Descrizione | Esempio |
|---|---|---|---|
| `vat_number` | Uno tra † | Partita IVA (persone giuridiche). Accetta prefisso `IT` o solo le 11 cifre. | `IT01234567890` |
| `codice_fiscale` | Uno tra † | Codice fiscale (persone fisiche, 16 caratteri). | `RSSMRA80A01H501U` |
| `sdi_code` | Uno tra ‡ | Codice destinatario SDI (esattamente 7 caratteri alfanumerici). | `ABC1234` |
| `pec` | Uno tra ‡ | PEC del destinatario, alternativa all'SDI code. | `azienda@pec.it` |
| `denominazione` | Uno tra § | Ragione sociale (persone giuridiche). | `Acme S.r.l.` |
| `nome` | Uno tra § | Nome (persone fisiche — obbligatorio insieme a `cognome`). | `Mario` |
| `cognome` | Uno tra § | Cognome (persone fisiche — obbligatorio insieme a `nome`). | `Rossi` |
| `indirizzo` | Sì | Via e numero civico. | `Via Roma 1` |
| `cap` | Sì | CAP (5 cifre per indirizzi italiani). | `00100` |
| `comune` | Sì | Comune. | `Roma` |
| `provincia` | IT only | Sigla provincia a 2 lettere (obbligatoria se `nazione=IT`). | `RM` |
| `nazione` | No | Codice ISO 3166-1 alpha-2. Default `IT`. | `IT` |

> † Almeno uno tra `vat_number` e `codice_fiscale` è obbligatorio.
> ‡ Almeno uno tra `sdi_code` e `pec` è obbligatorio.
> § Almeno uno tra `denominazione` e la coppia `nome`+`cognome` è obbligatorio.

Alias accettati: `partita_iva` (equivale a `vat_number`), `codice_destinatario` (equivale a `sdi_code`).

Per impostare i metadati via Dashboard:
**Customers** → seleziona cliente → **Metadata** → aggiungi le coppie chiave/valore.

Per impostarli via API (esempio completo per persona giuridica italiana):

```bash
stripe customers update cus_XXX \
  --metadata[vat_number]="IT01234567890" \
  --metadata[sdi_code]="ABC1234" \
  --metadata[denominazione]="Acme S.r.l." \
  --metadata[indirizzo]="Via Roma 1" \
  --metadata[cap]="00100" \
  --metadata[comune]="Roma" \
  --metadata[provincia]="RM" \
  --metadata[nazione]="IT"
```

Esempio per persona fisica:

```bash
stripe customers update cus_XXX \
  --metadata[codice_fiscale]="RSSMRA80A01H501U" \
  --metadata[pec]="mario.rossi@pec.it" \
  --metadata[nome]="Mario" \
  --metadata[cognome]="Rossi" \
  --metadata[indirizzo]="Via Roma 1" \
  --metadata[cap]="00100" \
  --metadata[comune]="Roma" \
  --metadata[provincia]="RM" \
  --metadata[nazione]="IT"
```

---

## 2. Stripe CLI

### 2.1 Installazione

**macOS (Homebrew):**
```bash
brew install stripe/stripe-cli/stripe
```

**Windows (Scoop):**
```powershell
scoop bucket add stripe https://github.com/stripe/scoop-stripe-cli.git
scoop install stripe
```

**Linux:**
```bash
# Debian/Ubuntu
curl -s https://packages.stripe.dev/api/security/keypair/stripe-cli-gpg/public \
  | gpg --dearmor | sudo tee /usr/share/keyrings/stripe.gpg > /dev/null
echo "deb [signed-by=/usr/share/keyrings/stripe.gpg] https://packages.stripe.dev/stripe-cli-debian-local stable main" \
  | sudo tee /etc/apt/sources.list.d/stripe.list
sudo apt update && sudo apt install stripe
```

Verifica l'installazione:
```bash
stripe version
```

### 2.2 Login

```bash
stripe login
```

Apre il browser per autorizzare la CLI con il tuo account Stripe. Le credenziali vengono salvate localmente.

Per ambienti CI/CD, usa una restricted key invece del login interattivo:
```bash
stripe login --api-key sk_test_...
```

### 2.3 Test locale con `stripe listen`

Avvia il forwarding verso il server locale:

```bash
stripe listen --forward-to localhost:3000/webhook
```

Output:
```
> Ready! You are using Stripe API Version [2024-06-20].
> Your webhook signing secret is whsec_abc123...  (←  copia questo valore)
> Press Ctrl + C to quit
```

**Copia il `whsec_...`** mostrato e impostalo nel tuo `.env`:

```
STRIPE_WEBHOOK_SECRET=whsec_abc123...
```

> Questo secret cambia ad ogni avvio di `stripe listen`. Non è lo stesso del signing secret dell'endpoint Dashboard — sono due secret separati.

### 2.4 Inviare eventi di prova

Con `stripe listen` attivo in un terminale, in un altro terminale:

```bash
# Testa invoice.paid (il flusso principale)
stripe trigger invoice.paid

# Testa un rimborso
stripe trigger charge.refunded

# Testa annullamento fattura
stripe trigger invoice.voided
```

Per verificare che il job sia stato creato nel DB:
```bash
npx prisma studio
# oppure
sqlite3 prisma/dev.db "SELECT id, stripeEventId, status, eventType FROM FatturaJob ORDER BY createdAt DESC LIMIT 5;"
```

# stripe-aruba-fatturazione

Node.js/TypeScript module that bridges **Stripe** payment events to **Aruba Fatturazione Elettronica** (Italian e-invoicing via SDI). Receives Stripe webhooks, generates FatturaPA XML, and uploads to Aruba — all without blocking the webhook response.

---

## Architecture

```
                        ┌─────────────────────────────────────────┐
                        │              Fastify server              │
                        │                                          │
Stripe ──POST /webhook──►  1. Verify HMAC signature               │
                        │  2. Idempotency check (stripeEventId)   │
                        │  3. INSERT FatturaJob PENDING            │
                        │  4. enqueue(jobId)   ──────────────────►│──┐
                        │  5. return HTTP 200 { received: true }  │  │
                        └─────────────────────────────────────────┘  │
                                                                      │
                        ┌─────────────────────────────────────────┐  │
                        │          p-queue worker (concurrency=1)  │◄─┘
                        │                                          │
                        │  processJob(jobId):                      │
                        │   ① Re-read DB (idempotency re-check)   │
                        │   ② Normalize + validate fiscal data     │
                        │   ③ POST to Aruba /uploadFile            │
                        │       ├── 2xx → CREATED_DRAFT/SENT_SDI  │
                        │       ├── 5xx → schedule retry (exp. backoff: 1m/5m/15m)
                        │       └── 4xx → FAILED_VALIDATION/ERROR │
                        │   ④ Update Stripe invoice metadata       │
                        │   ⑤ sendAlert() on failure              │
                        └─────────────────────────────────────────┘
                                          │
                                          ▼
                              Aruba SDI endpoint
                              (DEMO / PROD)
```

**Key design principle:** The webhook handler returns `200` immediately after DB insert. All Aruba I/O happens asynchronously in the worker — Stripe never times out waiting for a slow upstream.

---

## Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `PORT` | No | `3000` | HTTP port |
| `DATABASE_URL` | Yes | — | Prisma DB URL. SQLite only (`file:./dev.db`). The current `prisma/schema.prisma` uses `provider = "sqlite"` — PostgreSQL is not supported without updating the schema and migrations. |
| `STRIPE_SECRET_KEY` | Yes | — | Stripe secret key. Must start with `sk_test_` when `ARUBA_ENV=DEMO`. |
| `STRIPE_WEBHOOK_SECRET` | Yes | — | Webhook signing secret (`whsec_...`). From Dashboard endpoint or `stripe listen`. |
| `ARUBA_ENV` | No | `DEMO` | `DEMO` = Aruba sandbox. `PROD` = live SDI. `DEMO` requires `sk_test_` (enforced at boot). Use `sk_live_` for `PROD` (not enforced, but required by Stripe). |
| `ARUBA_SEND_MODE` | No | `DRAFT` | `DRAFT` = create bozza (no SDI send). `DIRECT` = send to SDI immediately. |
| `ARUBA_USERNAME` | Yes | — | Aruba account email. |
| `ARUBA_PASSWORD` | Yes | — | Aruba account password. |
| `ARUBA_CEDENTE_PIVA` | Yes* | `''` | P.IVA del cedente senza prefisso paese (11 cifre). Il paese è fornito da `ARUBA_CEDENTE_NAZIONE`. |
| `ARUBA_CEDENTE_DENOMINAZIONE` | Yes* | `''` | Ragione sociale del cedente. |
| `ARUBA_CEDENTE_INDIRIZZO` | Yes* | `''` | Via e numero civico del cedente. |
| `ARUBA_CEDENTE_CAP` | Yes* | `''` | CAP del cedente. |
| `ARUBA_CEDENTE_COMUNE` | Yes* | `''` | Comune del cedente. |
| `ARUBA_CEDENTE_PROVINCIA` | Yes* | `''` | Sigla provincia del cedente (es. `RM`). |
| `ARUBA_CEDENTE_NAZIONE` | No | `IT` | Codice nazione ISO 3166-1 alpha-2 del cedente. |
| `ARUBA_CEDENTE_REGIME_FISCALE` | No | `RF01` | Codice regime fiscale (FatturaPA). `RF01` = Ordinario. |
| `ALERT_WEBHOOK_URL` | No | _(disabled)_ | POST target for failure alerts (e.g. Slack incoming webhook). Leave empty to disable. |

> \* Technically defaults to empty string at boot, but Aruba will reject the XML. Set these before going to production.

---

## Setup

### Prerequisites

- Node.js ≥ 20
- npm ≥ 10

### Install

```bash
npm install
```

### Configure environment

```bash
cp .env.example .env
# Edit .env with your values
```

### Database

```bash
# Create/migrate the schema
npm run prisma:migrate

# Regenerate the Prisma client after schema changes
npm run prisma:generate
```

### Run (development)

```bash
npm run dev
```

Starts Fastify with `tsx watch` — restarts on file changes.

### Run (production)

```bash
npm run build
npm start
```

### Expose locally for Stripe webhooks

```bash
# In a separate terminal
stripe listen --forward-to localhost:3000/webhook
# Copy the printed whsec_... into STRIPE_WEBHOOK_SECRET in your .env
```

See [docs/stripe-setup.md](docs/stripe-setup.md) for full Stripe configuration instructions.

---

## Tests

```bash
# Run all tests
npm test

# Run with coverage report
npm run test:coverage
```

Coverage threshold: **80%** lines / functions / branches / statements. CI fails below this threshold.

Test stack: **Vitest** + **MSW v2** (mocks Aruba HTTP endpoints). The Stripe SDK is mocked via `vi.mock` because MSW does not intercept Stripe's custom HTTP agent in this Node version.

---

## Security

### Idempotency

Every Stripe event is stored with `stripeEventId UNIQUE`. Duplicate deliveries hit a Prisma `P2002` unique constraint and return `200` immediately — no double-processing. The worker also re-reads the job from DB before calling Aruba, guarding against race conditions if the same job is enqueued twice.

### DEMO/PROD isolation

Boot enforces one rule:

```
ARUBA_ENV=DEMO  →  STRIPE_SECRET_KEY must start with sk_test_  (enforced — boot fails otherwise)
ARUBA_ENV=PROD  →  use sk_live_...  (operational requirement, not checked at boot)
```

Using a live Stripe key against the Aruba demo environment is **rejected at startup** — this prevents real customer data from being sent to a test system. The reverse (`ARUBA_ENV=PROD` + `sk_test_`) is not blocked programmatically; ensure you set `sk_live_` before pointing to the Aruba production endpoint.

Aruba URLs are resolved at runtime:

| `ARUBA_ENV` | Base URL |
|---|---|
| `DEMO` | `https://demows.fatturazioneelettronica.aruba.it` |
| `PROD` | `https://ws.fatturazioneelettronica.aruba.it` |

### Default DRAFT mode

`ARUBA_SEND_MODE=DRAFT` is the default. In DRAFT mode, the invoice is uploaded to Aruba as a bozza — it is **not** forwarded to the SDI. Switch to `DIRECT` only when you have validated the output XML in the Aruba portal and are ready for production.

### Webhook signature verification

Every incoming request to `/webhook` is verified against `STRIPE_WEBHOOK_SECRET` using `stripe.webhooks.constructEvent()`. Requests with missing or invalid `Stripe-Signature` headers return `400` and are never processed.

### Retry backoff

Transient Aruba errors (5xx, network timeout) are retried with exponential backoff: **1 minute → 5 minutes → 15 minutes**. After three failures the job stays in `PENDING` with `nextRetryAt` set; the poll loop will retry it again. Non-retryable errors (4xx) set the job to `FAILED_VALIDATION` or `ERROR` immediately and trigger an alert.

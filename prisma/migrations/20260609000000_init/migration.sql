-- CreateTable
CREATE TABLE "FatturaJob" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "stripeEventId" TEXT NOT NULL,
    "stripeInvoiceId" TEXT,
    "stripeRefundId" TEXT,
    "fiscalDocumentKey" TEXT,
    "eventType" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "arubaInvoiceId" TEXT,
    "arubaUploadFileName" TEXT,
    "metadataSyncStatus" TEXT,
    "lockedAt" DATETIME,
    "lockedBy" TEXT,
    "retryCount" INTEGER NOT NULL DEFAULT 0,
    "nextRetryAt" DATETIME,
    "lastError" TEXT,
    "alerted" BOOLEAN NOT NULL DEFAULT false,
    "rawPayload" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "FatturaJob_stripeEventId_key" ON "FatturaJob"("stripeEventId");

-- CreateIndex
CREATE UNIQUE INDEX "FatturaJob_fiscalDocumentKey_key" ON "FatturaJob"("fiscalDocumentKey");

-- CreateIndex
CREATE INDEX "FatturaJob_status_nextRetryAt_idx" ON "FatturaJob"("status", "nextRetryAt");

-- CreateIndex
CREATE INDEX "FatturaJob_stripeEventId_idx" ON "FatturaJob"("stripeEventId");

-- CreateIndex
CREATE INDEX "FatturaJob_fiscalDocumentKey_idx" ON "FatturaJob"("fiscalDocumentKey");

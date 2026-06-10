import { describe, it, expect, vi, afterEach } from 'vitest';
import { META_SYNC_FAILED, META_SYNC_PENDING } from '../src/worker/processor.js';

// --- module mocks (hoisted so factories can reference them) ---

const { mockProcessJob, mockFindMany } = vi.hoisted(() => ({
  mockProcessJob: vi.fn().mockResolvedValue(undefined),
  mockFindMany: vi.fn(),
}));

vi.mock('../src/worker/processor.js', () => ({
  processJob: mockProcessJob,
  STALE_LOCK_MS: 600_000,
  META_SYNC_PENDING: 'PENDING',
  META_SYNC_FAILED: 'FAILED',
}));

vi.mock('../src/db/prisma.js', () => ({
  prisma: {
    fatturaJob: {
      findMany: mockFindMany,
    },
  },
}));

import { pollPendingJobs, queue, stopWorker } from '../src/worker/queue.js';

afterEach(() => {
  vi.clearAllMocks();
  stopWorker();
});

describe('pollPendingJobs: filter uses stripeInvoiceId for metadata retry', () => {
  it('queries with stripeInvoiceId (not arubaInvoiceId) in the metadata-retry OR branch', async () => {
    mockFindMany.mockResolvedValueOnce([]);

    await pollPendingJobs();

    expect(mockFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          OR: expect.arrayContaining([
            expect.objectContaining({
              stripeInvoiceId: { not: null },
              metadataSyncStatus: { in: [META_SYNC_PENDING, META_SYNC_FAILED] },
            }),
          ]),
        }),
      }),
    );
  });
});

describe('pollPendingJobs: FAILED_VALIDATION job with null arubaInvoiceId gets enqueued', () => {
  it('job with stripeInvoiceId and metadataSyncStatus=FAILED causes processJob to be called', async () => {
    const failedJob = {
      id: 'job_failed_poll_001',
      stripeInvoiceId: 'in_test_poll',
      arubaInvoiceId: null,
      status: 'FAILED_VALIDATION',
      metadataSyncStatus: META_SYNC_FAILED,
    };

    mockFindMany.mockResolvedValueOnce([failedJob]);

    await pollPendingJobs();
    await queue.onIdle();

    // processJob (mocked) was called with the job id — confirms enqueue fired
    expect(mockProcessJob).toHaveBeenCalledWith('job_failed_poll_001');
  });
});

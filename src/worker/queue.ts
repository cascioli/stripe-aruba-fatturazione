import PQueue from 'p-queue';
import { prisma } from '../db/prisma.js';
import { processJob, STALE_LOCK_MS, META_SYNC_PENDING, META_SYNC_FAILED } from './processor.js';

export const queue = new PQueue({ concurrency: 1 });

const POLL_INTERVAL_MS = 5_000;

let pollTimer: ReturnType<typeof setInterval> | null = null;
const inFlightJobs = new Set<string>();

export function enqueue(jobId: string): void {
  if (inFlightJobs.has(jobId)) return;
  inFlightJobs.add(jobId);
  void queue.add(() => processJob(jobId).finally(() => inFlightJobs.delete(jobId)));
}

export function startWorker(): void {
  if (pollTimer) return;
  void pollPendingJobs();
  pollTimer = setInterval(() => void pollPendingJobs(), POLL_INTERVAL_MS);
}

export function stopWorker(): void {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  queue.clear();
}

export async function pollPendingJobs(): Promise<void> {
  const now = new Date();
  const staleCutoff = new Date(now.getTime() - STALE_LOCK_MS);

  const jobs = await prisma.fatturaJob.findMany({
    where: {
      OR: [
        // PENDING jobs ready for Aruba — skip freshly locked ones to avoid collisions
        {
          status: 'PENDING',
          AND: [
            { OR: [{ nextRetryAt: null }, { nextRetryAt: { lte: now } }] },
            { OR: [{ lockedAt: null }, { lockedAt: { lte: staleCutoff } }] },
          ],
        },
        // Jobs with a Stripe invoice that still need the metadata write-back (success or failure state)
        {
          stripeInvoiceId: { not: null },
          metadataSyncStatus: { in: [META_SYNC_PENDING, META_SYNC_FAILED] },
        },
      ],
    },
    select: { id: true },
    take: 50,
  });

  for (const { id } of jobs) {
    enqueue(id);
  }
}

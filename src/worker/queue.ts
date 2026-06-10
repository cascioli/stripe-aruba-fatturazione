import PQueue from 'p-queue';
import { prisma } from '../db/prisma.js';
import { processJob } from './processor.js';

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

async function pollPendingJobs(): Promise<void> {
  const now = new Date();
  const jobs = await prisma.fatturaJob.findMany({
    where: {
      status: 'PENDING',
      OR: [{ nextRetryAt: null }, { nextRetryAt: { lte: now } }],
    },
    select: { id: true },
    take: 50,
  });

  for (const { id } of jobs) {
    enqueue(id);
  }
}

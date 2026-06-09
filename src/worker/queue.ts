import PQueue from 'p-queue';

const queue = new PQueue({ concurrency: 1 });

export function enqueue(jobId: string): void {
  void queue.add(() => processJob(jobId));
}

// Phase 2: read job from DB, build Aruba XML, call SDI
async function processJob(_jobId: string): Promise<void> {}

import { DelayedError, Job } from 'bullmq';

/**
 * Paces a campaign to its project's `maxSendsPerMinute` by giving its worker slot up
 * between pages, rather than sleeping in it.
 *
 * Campaign delivery has two slots shared by every tenant. A page sent, then a sleep
 * inside the job, kept a slot for as long as one tenant's throttled audience lasted
 * (hours, at a low rate), stalling every other tenant's sends. Instead the job is moved
 * to BullMQ's delayed set until its next page may go, and the slot is free meanwhile;
 * it resumes from the checkpoint each page writes. Call only after the page's
 * checkpoint is recorded.
 */
export async function yieldForPacing(job: Job, sentInPage: number, maxSendsPerMinute: number | null): Promise<void> {
  if (!maxSendsPerMinute || maxSendsPerMinute <= 0 || sentInPage <= 0) return;
  const waitMs = Math.ceil((sentInPage / maxSendsPerMinute) * 60_000);
  if (waitMs <= 0) return;
  if (!job.token) {
    // Not run by a worker (a direct call): nothing to hand back, so wait in place.
    await new Promise((resolve) => setTimeout(resolve, Math.min(waitMs, 60_000)));
    return;
  }
  await job.moveToDelayed(Date.now() + waitMs, job.token);
  throw new DelayedError();
}

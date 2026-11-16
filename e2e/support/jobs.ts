import { execFile } from 'child_process';
import path from 'path';
import { appEnvironment, REPO_ROOT, runSecrets, stackPorts } from './stack';

/**
 * Worker jobs on demand. The worker's periodic jobs are in-process crons (@nestjs/schedule),
 * not queued jobs, so nothing in Redis can start one early. `runJobNow` runs one the way
 * its cron does: a short-lived process (`run-job.cjs`) builds the worker's module from the
 * built API, with the stack's environment, mounts no cron and consumes no queue, calls the
 * scheduler method the cron calls, and exits. The stack's own worker keeps running; every
 * job here already tolerates a second worker (claims, advisory locks, conditional updates).
 *
 * Each cron method catches and logs its own failures, so a run that logged an error is
 * refused (pass `allowErrors` to get the output instead).
 */
export const WORKER_JOBS = {
  /** Billing: catch up on missed webhooks (hourly at :45). */
  'billing-reconcile': { file: 'queue/scheduler/billing.scheduler.js', className: 'BillingScheduler', method: 'reconcile' },
  /** Billing: send the cancels queued in the outbox (every minute). */
  'billing-outbox': { file: 'queue/scheduler/billing.scheduler.js', className: 'BillingScheduler', method: 'outbox' },
  /** Billing: the 80% and 100% MAU notices (daily at 01:15 UTC). */
  'mau-notices': { file: 'queue/scheduler/billing.scheduler.js', className: 'BillingScheduler', method: 'mauNotices' },
  /** Usage roll-up: close finished days, count today, record active devices (hourly at :30). */
  'usage-rollup': { file: 'queue/scheduler/usage-rollup.scheduler.js', className: 'UsageRollupScheduler', method: 'handleTick' },
  /** Staff factor resets whose wait is over, and unsent warnings (every 5 minutes). */
  'factor-reset-sweep': { file: 'queue/scheduler/factor-reset.scheduler.js', className: 'FactorResetScheduler', method: 'handleSweep' },
  /** Incident reminders at 4 and 5 hours (every minute). */
  'incident-reminders': { file: 'modules/incidents/incident-reminders.scheduler.js', className: 'IncidentRemindersScheduler', method: 'handle' },
  /**
   * Segment refresh (every 5 minutes): enqueues materialisation of the segments that are
   * due; the stack's worker runs the jobs, so wait for `last_materialized_at` afterwards.
   */
  'segment-refresh': { file: 'queue/scheduler/segment-refresh.scheduler.js', className: 'SegmentRefreshScheduler', method: 'handleRefresh' },
  /** Journey tick (every minute): enrol people who newly match, then advance due runs. */
  'journey-tick': { file: 'queue/scheduler/journey.scheduler.js', className: 'JourneyScheduler', method: 'handleTick' },
  /** Journey runs claimed and never resolved, made due again (every 5 minutes). */
  'journey-stranded-sweep': { file: 'queue/scheduler/journey.scheduler.js', className: 'JourneyScheduler', method: 'handleStrandedRuns' },
  /**
   * Push schedule tick (every minute), for every channel's campaigns: suspension
   * retirements, recurring spawns, experiment and timezone splits, then promotion of due
   * campaigns onto the queue (the stack's worker sends them).
   */
  'push-schedule-tick': { file: 'queue/scheduler/push-campaign-schedule.scheduler.js', className: 'PushCampaignScheduleScheduler', method: 'handleTick' },
  /** Queued or sending campaigns with no live job and no progress for 15 minutes, failed (every 5 minutes). */
  'push-reconcile': { file: 'queue/scheduler/push-campaign-reconciliation.scheduler.js', className: 'PushCampaignReconciliationScheduler', method: 'handleSweep' },
  /** Pending email double opt-in confirmations, mailed through the tenant's provider (every minute). */
  'email-confirmations': { file: 'queue/scheduler/email-confirmation.scheduler.js', className: 'EmailConfirmationScheduler', method: 'tick' },
} as const;

export type WorkerJob = keyof typeof WORKER_JOBS;

export interface JobRun {
  /** What the method returned (the cron methods return nothing, so usually null). */
  result: unknown;
  /** Everything the process printed: Nest's log lines, the job's included. */
  output: string;
}

const API_DIR = path.join(REPO_ROOT, 'apps/api');
const RUNNER = path.join(__dirname, 'run-job.cjs');
/** A line Nest's console logger writes for `logger.error`. */
const ERROR_LINE = /\bERROR \[/;

export async function runJobNow(name: WorkerJob, options: { allowErrors?: boolean; timeoutMs?: number } = {}): Promise<JobRun> {
  const job = WORKER_JOBS[name];
  if (!job) throw new Error(`Unknown worker job "${name}"`);
  const env = { ...process.env, ...appEnvironment(runSecrets(), stackPorts()) };
  const output = await new Promise<string>((resolve, reject) => {
    execFile(
      process.execPath,
      [RUNNER, job.file, job.className, job.method],
      { cwd: API_DIR, env, timeout: options.timeoutMs ?? 60_000, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout, stderr) => {
        const all = `${stdout}${stderr}`;
        if (error) reject(new Error(`Worker job ${name} failed (${error.message.split('\n')[0]}):\n${all}`));
        else resolve(all);
      },
    );
  });
  if (!options.allowErrors && ERROR_LINE.test(output)) {
    throw new Error(`Worker job ${name} logged an error:\n${output}`);
  }
  const last = output.split('\n').reverse().find((line) => line.startsWith('RUN_JOB_RESULT '));
  if (!last) throw new Error(`Worker job ${name} printed no result:\n${output}`);
  return { result: JSON.parse(last.slice('RUN_JOB_RESULT '.length)), output };
}

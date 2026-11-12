import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectQueue } from '@nestjs/bullmq';
import { InjectRepository } from '@nestjs/typeorm';
import { Queue } from 'bullmq';
import { Repository, In, LessThan } from 'typeorm';
import {
  PushNotificationLogEntity,
  NON_TERMINAL_STATUSES,
} from '../../modules/push-notifications/entities/push-notification-log.entity';
import { PushCampaignStateService } from '../../modules/push-notifications/push-campaign-state.service';
import { QUEUE_PUSH_CAMPAIGN, PushCampaignJobData } from '../queue.constants';

/**
 * How long a campaign may go without recording any progress before the sweep
 * treats it as abandoned. A live campaign bumps `updatedAt` at every batch
 * checkpoint, so this only has to exceed the time one 500-token FCM batch can
 * reasonably take — generously.
 */
const NO_PROGRESS_MS = 15 * 60 * 1000;

/**
 * Returns campaigns that no longer have a delivery job to a terminal status.
 *
 * The processor's `failed` handler marks a campaign failed once its retries are
 * exhausted, guarded on `attemptsMade >= attempts`. That guard is a *proxy* for
 * "BullMQ will try again", and it is wrong for every terminal path that does
 * not consume an attempt — a second stall under `maxStalledCount: 1` raises
 * `UnrecoverableError('job stalled more than allowable limit')` and fails the
 * job with `attemptsMade` still below `attempts`, so the guard returns early
 * and the row sits in `sending` forever while the dashboard polls it every 3s.
 * That is one instance of a class, so this sweep reconciles against the fact
 * that actually matters rather than against another proxy: the job is gone or
 * has already reached a terminal state, and nothing has moved for a while,
 * therefore nobody is going to finish it.
 */
@Injectable()
export class PushCampaignReconciliationScheduler {
  private readonly logger = new Logger(PushCampaignReconciliationScheduler.name);

  constructor(
    @InjectRepository(PushNotificationLogEntity)
    private readonly logRepository: Repository<PushNotificationLogEntity>,
    @InjectQueue(QUEUE_PUSH_CAMPAIGN)
    private readonly pushQueue: Queue<PushCampaignJobData>,
    private readonly state: PushCampaignStateService,
  ) {}

  @Cron(CronExpression.EVERY_5_MINUTES)
  async handleSweep(): Promise<void> {
    const count = await this.reconcileStrandedCampaigns();
    if (count > 0) {
      this.logger.warn(`Reconciled ${count} stranded push campaign(s)`);
    }
  }

  /**
   * Split out from the cron handler so it can be tested and triggered manually.
   */
  async reconcileStrandedCampaigns(): Promise<number> {
    const staleBefore = new Date(Date.now() - NO_PROGRESS_MS);

    const candidates = await this.logRepository.find({
      where: {
        status: In(NON_TERMINAL_STATUSES),
        updatedAt: LessThan(staleBefore),
      },
      select: ['id'],
    });

    let reconciled = 0;

    for (const candidate of candidates) {
      // send() enqueues with jobId = log.id, so this is an exact lookup rather
      // than a scan. getJob is a plain hash read, and removeOnComplete /
      // removeOnFail deliberately retain finished jobs, so a hash existing is
      // not proof BullMQ still owns the campaign — only the absence of a
      // *finishedOn* timestamp is. A job that's waiting, delayed between
      // retries, or active has no finishedOn yet; one that failed or
      // completed does, even though its hash is still sitting in Redis.
      const job = await this.pushQueue.getJob(candidate.id);
      if (job && !job.finishedOn) continue;

      const status = await this.state.markFailed(
        candidate.id,
        `Campaign abandoned: no delivery job remains and no progress was recorded for over ${NO_PROGRESS_MS / 60000} minutes.`,
      );
      this.logger.warn(
        `Stranded campaign ${candidate.id} reconciled to ${status}`,
      );
      reconciled += 1;
    }

    return reconciled;
  }
}

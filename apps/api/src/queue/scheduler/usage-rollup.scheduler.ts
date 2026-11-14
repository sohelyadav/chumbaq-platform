import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { logValue } from '../../common/log-value';
import { UsageRollupService } from '../../modules/usage/usage-rollup.service';

/**
 * Rolls usage up every hour at half past, in UTC: the 00:30 run closes
 * yesterday, every run keeps today's counts fresh and catches up after
 * downtime. The service holds an advisory lock, so a second worker on the same
 * database (or a restart overlapping a run) skips instead of counting twice.
 */
@Injectable()
export class UsageRollupScheduler {
  private readonly logger = new Logger(UsageRollupScheduler.name);

  constructor(private readonly rollup: UsageRollupService) {}

  @Cron('30 * * * *', { name: 'usage-rollup', timeZone: 'UTC' })
  async handleTick(): Promise<void> {
    try {
      const tick = await this.rollup.runTick();
      if (tick.status === 'skipped') {
        this.logger.debug('Usage roll-up skipped: another run holds the lock');
      }
    } catch (error) {
      this.logger.error(`Usage roll-up failed: ${logValue((error as Error).message)}`);
    }
  }
}

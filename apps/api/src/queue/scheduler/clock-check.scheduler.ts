import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { readClock } from '../../modules/admin/clock';

/**
 * Hourly: a clock that is unsynchronised or more than a second off is written to the
 * worker's log, so drift is in the 180-day logs CERT-In asks for, not only on the admin
 * Health page. Silent where chrony is not installed (development machines).
 */
@Injectable()
export class ClockCheckScheduler {
  private readonly logger = new Logger(ClockCheckScheduler.name);

  @Cron(CronExpression.EVERY_HOUR)
  async check(read = readClock): Promise<void> {
    const clock = await read();
    if (clock.state === 'bad') {
      this.logger.warn(
        clock.source
          ? `Clock offset ${clock.offsetMs} ms from ${clock.source}`
          : 'Clock is not synchronised to any time source',
      );
    }
  }
}

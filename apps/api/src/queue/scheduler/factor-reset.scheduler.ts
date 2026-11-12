import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { FactorResetsService } from '../../modules/factor-resets/factor-resets.service';

/**
 * Carries out staff factor resets once their wait is over. A reset may run up to five
 * minutes late, which against a wait of days does not matter. Several workers may run
 * this at once: `execute` claims each reset with a conditional update.
 */
@Injectable()
export class FactorResetScheduler {
  private readonly logger = new Logger(FactorResetScheduler.name);

  constructor(private readonly resets: FactorResetsService) {}

  @Cron(CronExpression.EVERY_5_MINUTES)
  async handleSweep(): Promise<void> {
    const done = await this.resets.executeDue();
    if (done > 0) this.logger.log(`Carried out ${done} factor reset(s)`);
  }
}

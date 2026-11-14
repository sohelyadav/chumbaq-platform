import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { EmailConfirmationsService } from '../../modules/email/email-confirmations.service';

/** Mails pending double opt-in confirmations (`EmailConfirmationsService.sendPending`). */
@Injectable()
export class EmailConfirmationScheduler {
  private readonly logger = new Logger(EmailConfirmationScheduler.name);
  private running = false;

  constructor(private readonly confirmations: EmailConfirmationsService) {}

  @Cron(CronExpression.EVERY_MINUTE)
  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const sent = await this.confirmations.sendPending();
      if (sent > 0) this.logger.log(`Sent ${sent} email confirmation(s)`);
    } catch (error) {
      this.logger.error(`Email confirmations failed: ${(error as Error).message}`);
    } finally {
      this.running = false;
    }
  }
}

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { accountLink, mauNoticeEmail, paymentHaltedEmail } from '../platform-email/account-emails';
import { PlatformEmailService } from '../platform-email/platform-email.service';
import type { BillingNotice } from './billing-state.service';
import type { BillingNoticesHandler } from './billing-webhooks.service';

export const BILLING_PAGE_PATH = '/account/billing';

/**
 * Billing's account email, through platform email (which answers `sent: false` when it
 * is not set up, never throws). Links only from `app.appUrl`. Callers never wait on
 * it from a webhook; a failure is logged and dropped.
 */
@Injectable()
export class BillingEmailsService implements BillingNoticesHandler {
  private readonly logger = new Logger(BillingEmailsService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly platformEmail: PlatformEmailService,
    private readonly config: ConfigService,
  ) {}

  private get billingLink(): string {
    return accountLink(this.config.get<string>('app.appUrl') ?? '', BILLING_PAGE_PATH);
  }

  async send(notices: BillingNotice[]): Promise<void> {
    for (const notice of notices) {
      const user = await this.recipient(notice.userId);
      if (!user) continue;
      const result = await this.platformEmail.send(paymentHaltedEmail(user, notice.graceUntil, this.billingLink));
      if (!result.sent) this.logger.warn(`Payment halted notice not sent: ${result.reason}`);
    }
  }

  /** True when the provider accepted it. */
  async mauNotice(
    userId: string,
    input: { level: 80 | 100; mau: number; limit: number; planName: string; month: string },
  ): Promise<boolean> {
    const user = await this.recipient(userId);
    if (!user) return false;
    const result = await this.platformEmail.send(mauNoticeEmail(user, input, this.billingLink));
    return result.sent;
  }

  private async recipient(userId: string): Promise<{ email: string; name: string } | null> {
    const [row] = await this.dataSource.query(`SELECT email, name FROM users WHERE id = $1`, [userId]);
    return row ? { email: row.email, name: row.name } : null;
  }
}

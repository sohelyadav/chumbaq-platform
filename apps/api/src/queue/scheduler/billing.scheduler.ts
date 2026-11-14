import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { logValue } from '../../common/log-value';
import type { BillingConfig } from '../../config/billing.config';
import { BillingOutboxService } from '../../modules/billing/billing-outbox.service';
import { BillingReconcileService } from '../../modules/billing/billing-reconcile.service';
import { MauNoticesService } from '../../modules/billing/mau-notices.service';

/**
 * Billing's worker jobs, in UTC, each doing nothing while billing is off:
 * - every minute, send the cancels queued in the outbox;
 * - hourly, catch up on webhooks that never arrived;
 * - daily after the 00:30 usage roll-up, the MAU notices.
 * A failure is logged and the next run tries again.
 */
@Injectable()
export class BillingScheduler {
  private readonly logger = new Logger(BillingScheduler.name);

  constructor(
    private readonly config: ConfigService,
    private readonly outboxService: BillingOutboxService,
    private readonly reconcileService: BillingReconcileService,
    private readonly mauNoticesService: MauNoticesService,
  ) {}

  private get enabled(): boolean {
    return this.config.get<BillingConfig>('billing')?.enabled === true;
  }

  @Cron('* * * * *', { name: 'billing-outbox', timeZone: 'UTC' })
  async outbox(): Promise<void> {
    await this.run('Billing outbox', () => this.outboxService.runOnce());
  }

  @Cron('45 * * * *', { name: 'billing-reconcile', timeZone: 'UTC' })
  async reconcile(): Promise<void> {
    await this.run('Billing reconciliation', () => this.reconcileService.runOnce());
  }

  @Cron('15 1 * * *', { name: 'billing-mau-notices', timeZone: 'UTC' })
  async mauNotices(): Promise<void> {
    await this.run('MAU notices', () => this.mauNoticesService.runOnce());
  }

  private async run(label: string, job: () => Promise<unknown>): Promise<void> {
    if (!this.enabled) return;
    try {
      await job();
    } catch (error) {
      this.logger.error(`${label} failed: ${logValue((error as Error).message)}`);
    }
  }
}

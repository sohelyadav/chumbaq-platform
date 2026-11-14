import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SCHEDULE_CRON_OPTIONS } from '@nestjs/schedule/dist/schedule.constants';
import type { BillingOutboxService } from '../../modules/billing/billing-outbox.service';
import type { BillingReconcileService } from '../../modules/billing/billing-reconcile.service';
import type { MauNoticesService } from '../../modules/billing/mau-notices.service';
import { BillingScheduler } from './billing.scheduler';

describe('BillingScheduler', () => {
  const error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  beforeEach(() => error.mockClear());

  function build(enabled: boolean, overrides: { fail?: boolean } = {}) {
    const run = jest.fn(async () => {
      if (overrides.fail) throw new Error('provider down\nforged line');
      return 0;
    });
    const outbox = { runOnce: run } as unknown as BillingOutboxService;
    const reconcile = { runOnce: run } as unknown as BillingReconcileService;
    const notices = { runOnce: jest.fn(async () => ({ sent: 0, skipped: 0 })) } as unknown as MauNoticesService;
    if (overrides.fail) (notices.runOnce as jest.Mock).mockImplementation(run);
    const config = { get: (key: string) => (key === 'billing' ? { enabled } : undefined) } as unknown as ConfigService;
    return { scheduler: new BillingScheduler(config, outbox, reconcile, notices), run, notices };
  }

  it('runs the outbox every minute, reconciliation hourly and MAU notices daily, in UTC', () => {
    const cron = (method: keyof BillingScheduler) =>
      Reflect.getMetadata(SCHEDULE_CRON_OPTIONS, BillingScheduler.prototype[method]);
    expect(cron('outbox')).toMatchObject({ cronTime: '* * * * *', name: 'billing-outbox', timeZone: 'UTC' });
    expect(cron('reconcile')).toMatchObject({ cronTime: '45 * * * *', name: 'billing-reconcile', timeZone: 'UTC' });
    expect(cron('mauNotices')).toMatchObject({ cronTime: '15 1 * * *', name: 'billing-mau-notices', timeZone: 'UTC' });
  });

  it('does nothing while billing is off', async () => {
    const { scheduler, run, notices } = build(false);
    await scheduler.outbox();
    await scheduler.reconcile();
    await scheduler.mauNotices();
    expect(run).not.toHaveBeenCalled();
    expect(notices.runOnce).not.toHaveBeenCalled();
  });

  it('runs each job while billing is on', async () => {
    const { scheduler, run, notices } = build(true);
    await scheduler.outbox();
    await scheduler.reconcile();
    await scheduler.mauNotices();
    expect(run).toHaveBeenCalledTimes(2);
    expect(notices.runOnce).toHaveBeenCalledTimes(1);
  });

  it('catches a failing job and logs it escaped', async () => {
    const { scheduler } = build(true, { fail: true });
    await expect(scheduler.outbox()).resolves.toBeUndefined();
    await expect(scheduler.reconcile()).resolves.toBeUndefined();
    await expect(scheduler.mauNotices()).resolves.toBeUndefined();
    expect(error).toHaveBeenCalledTimes(3);
    expect(error).toHaveBeenCalledWith('Billing outbox failed: "provider down\\nforged line"');
  });
});

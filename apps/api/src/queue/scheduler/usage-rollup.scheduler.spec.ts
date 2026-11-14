import { Logger } from '@nestjs/common';
import { SCHEDULE_CRON_OPTIONS } from '@nestjs/schedule/dist/schedule.constants';
import type { UsageRollupService } from '../../modules/usage/usage-rollup.service';
import { UsageRollupScheduler } from './usage-rollup.scheduler';

describe('UsageRollupScheduler', () => {
  const error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  const debug = jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
  beforeEach(() => {
    error.mockClear();
    debug.mockClear();
  });

  const scheduler = (runTick: UsageRollupService['runTick']) =>
    new UsageRollupScheduler({ runTick } as UsageRollupService);

  it('runs hourly at half past, in UTC, so 00:30 UTC closes yesterday', () => {
    const options = Reflect.getMetadata(SCHEDULE_CRON_OPTIONS, UsageRollupScheduler.prototype.handleTick);
    expect(options).toMatchObject({ cronTime: '30 * * * *', timeZone: 'UTC' });
  });

  it('logs a failed run, escaped, and never throws', async () => {
    await expect(
      scheduler(async () => {
        throw new Error('connection reset\nUsage closed 2026-11-13: forged');
      }).handleTick(),
    ).resolves.toBeUndefined();
    expect(error).toHaveBeenCalledWith('Usage roll-up failed: "connection reset\\nUsage closed 2026-11-13: forged"');
  });

  it('says so quietly when another run holds the lock', async () => {
    await scheduler(async () => ({ status: 'skipped' })).handleTick();
    expect(debug).toHaveBeenCalledWith('Usage roll-up skipped: another run holds the lock');
    expect(error).not.toHaveBeenCalled();
  });
});

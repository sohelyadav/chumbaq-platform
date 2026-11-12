import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { SecurityRetentionScheduler } from './security-retention.scheduler';

/** Which rows go is proved against Postgres in the integration spec; this is the cron. */
describe('SecurityRetentionScheduler', () => {
  const config = new ConfigService({
    retention: { authEventDays: 365, activityLogDays: 365 },
    jwt: { refreshLifetimeMs: 7 * 86_400_000 },
  });

  afterEach(() => jest.restoreAllMocks());

  it('logs what each daily run deleted', async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce([{ n: 3 }])
      .mockResolvedValueOnce([{ n: 2 }])
      .mockResolvedValueOnce([{ n: 1 }])
      .mockResolvedValueOnce([{ n: 4 }])
      .mockResolvedValueOnce([{ n: 5 }])
      .mockResolvedValueOnce([{ n: 6 }]);
    // The activity log's batch runs in a transaction, so its query goes through the manager.
    // Its `SET LOCAL` is answered here so it does not use up a count meant for the delete.
    const manager = {
      query: (sql: string, params?: unknown[]) =>
        sql.startsWith('SET LOCAL') ? Promise.resolve([]) : query(sql, params),
    };
    const transaction = jest.fn((work: (manager: unknown) => unknown) => work(manager));
    const log = jest.spyOn(Logger.prototype, 'log').mockImplementation();
    const scheduler = new SecurityRetentionScheduler(
      { query, transaction } as unknown as DataSource,
      config,
    );

    await scheduler.handleDailyPrune();

    expect(log).toHaveBeenCalledWith(
      'Pruned 3 auth event(s), 2 session(s), 1 account token(s), 4 staff session(s), 5 view-as code(s), 6 activity entries',
    );
  });

  it('logs a failure instead of throwing out of the cron', async () => {
    const query = jest.fn().mockRejectedValue(new Error('connection lost'));
    const error = jest.spyOn(Logger.prototype, 'error').mockImplementation();
    const scheduler = new SecurityRetentionScheduler({ query } as unknown as DataSource, config);

    await expect(scheduler.handleDailyPrune()).resolves.toBeUndefined();
    expect(error).toHaveBeenCalledWith(expect.stringContaining('connection lost'));
  });
});

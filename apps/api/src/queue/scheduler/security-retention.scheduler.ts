import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { DataSource } from 'typeorm';
import { DEFAULT_STAFF_SESSION_MAX_AGE_MS } from '../../config/staff.config';

/**
 * Rows per DELETE. Each batch is its own short transaction, so a large backlog (the
 * first run after this shipped) never holds row locks or bloats one transaction.
 */
export const RETENTION_BATCH_SIZE = 5000;

/**
 * Ended sessions are kept a month, so "signed out from where?" can still be answered.
 * This is also as far back as `SessionsService.isNewDevice` can see, so a device
 * unused for longer than this gets a new-device notice again: extra, never missed.
 */
const SESSION_GRACE_SECONDS = 30 * 24 * 3600;

/** Spent or expired tokens. The send limit only counts the last hour of them. */
const TOKEN_GRACE_SECONDS = 7 * 24 * 3600;

/** View-as codes live a minute; a week after that they answer nothing anyone asks. */
const HANDOFF_GRACE_SECONDS = 7 * 24 * 3600;

export interface RetentionCounts {
  authEvents: number;
  authSessions: number;
  accountTokens: number;
  staffSessions: number;
  impersonationHandoffs: number;
  projectActivity: number;
}

/**
 * Deletes security records nobody needs any more.
 *
 * Every pass is fail-closed for the API: a missing `auth_sessions` row refuses a
 * refresh and an access token, and a missing `account_tokens` row is an invalid link,
 * so deleting too much can only sign someone out, never let anyone in.
 *
 * Safe on several workers: rows are claimed with `FOR UPDATE SKIP LOCKED`, so two runs
 * divide the rows between them instead of waiting on, or double-counting, each other.
 */
@Injectable()
export class SecurityRetentionScheduler {
  private readonly logger = new Logger(SecurityRetentionScheduler.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly config: ConfigService,
  ) {}

  @Cron(CronExpression.EVERY_DAY_AT_3AM)
  async handleDailyPrune(): Promise<void> {
    try {
      const counts = await this.prune();
      this.logger.log(
        `Pruned ${counts.authEvents} auth event(s), ${counts.authSessions} session(s), ` +
          `${counts.accountTokens} account token(s), ${counts.staffSessions} staff session(s), ` +
          `${counts.impersonationHandoffs} view-as code(s), ` +
          `${counts.projectActivity} activity entr${counts.projectActivity === 1 ? 'y' : 'ies'}`,
      );
    } catch (error) {
      this.logger.error(`Security record pruning failed: ${(error as Error).message}`);
    }
  }

  /** Split out from the cron handler so it can be tested and triggered manually. */
  async prune(batchSize = RETENTION_BATCH_SIZE): Promise<RetentionCounts> {
    const eventSeconds =
      this.config.getOrThrow<number>('retention.authEventDays') * 24 * 3600;
    // A session idle past its refresh lifetime has no token left that works, so the
    // month's grace runs from then, as it does from a revocation.
    const idleSeconds =
      this.config.getOrThrow<number>('jwt.refreshLifetimeMs') / 1000 + SESSION_GRACE_SECONDS;

    const authEvents = await this.deleteInBatches(
      'auth_events',
      `created_at < now() - make_interval(secs => $1)`,
      [eventSeconds],
      batchSize,
    );
    const authSessions = await this.deleteInBatches(
      'auth_sessions',
      `revoked_at < now() - make_interval(secs => $1)
       OR last_used_at < now() - make_interval(secs => $2)`,
      [SESSION_GRACE_SECONDS, idleSeconds],
      batchSize,
    );
    const accountTokens = await this.deleteInBatches(
      'account_tokens',
      `used_at < now() - make_interval(secs => $1)
       OR expires_at < now() - make_interval(secs => $1)`,
      [TOKEN_GRACE_SECONDS],
      batchSize,
    );

    // A staff session past its absolute end can do nothing, so the month's grace runs
    // from then, as from a revocation. Its view-as codes go with it (cascade).
    const staffSessionSeconds =
      (this.config.get<number>('staff.maxAgeMs') ?? DEFAULT_STAFF_SESSION_MAX_AGE_MS) / 1000 + SESSION_GRACE_SECONDS;
    const staffSessions = await this.deleteInBatches(
      'staff_sessions',
      `revoked_at < now() - make_interval(secs => $1)
       OR created_at < now() - make_interval(secs => $2)`,
      [SESSION_GRACE_SECONDS, staffSessionSeconds],
      batchSize,
    );
    const impersonationHandoffs = await this.deleteInBatches(
      'impersonation_handoffs',
      `expires_at < now() - make_interval(secs => $1)`,
      [HANDOFF_GRACE_SECONDS],
      batchSize,
    );

    // The activity log is append-only in the database: its trigger refuses a DELETE unless
    // the transaction sets this flag, and even then only for rows past 180 days. The
    // config already refuses fewer days than that.
    const projectActivity = await this.deleteInBatches(
      'project_activity',
      `occurred_at < now() - make_interval(days => $1)`,
      [this.config.getOrThrow<number>('retention.activityLogDays')],
      batchSize,
      { activityRetention: true },
    );

    return {
      authEvents,
      authSessions,
      accountTokens,
      staffSessions,
      impersonationHandoffs,
      projectActivity,
    };
  }

  /**
   * Repeats until a batch comes back short. A short batch can also mean another
   * worker holds the rest, which is fine: that worker keeps going until it finishes.
   * `table` and `predicate` are constants above, never input.
   */
  private async deleteInBatches(
    table: string,
    predicate: string,
    params: number[],
    batchSize: number,
    options: { activityRetention?: boolean } = {},
  ): Promise<number> {
    const limitParam = `$${params.length + 1}`;
    const sql = `
      WITH doomed AS (
        SELECT id FROM ${table} WHERE (${predicate})
        LIMIT ${limitParam} FOR UPDATE SKIP LOCKED
      ), deleted AS (
        DELETE FROM ${table} t USING doomed WHERE t.id = doomed.id RETURNING 1
      )
      SELECT count(*)::int AS n FROM deleted`;

    let total = 0;
    for (;;) {
      const [{ n }] = options.activityRetention
        ? await this.deleteActivityBatch(sql, [...params, batchSize])
        : ((await this.dataSource.query(sql, [...params, batchSize])) as { n: number }[]);
      total += n;
      if (n < batchSize) return total;
    }
  }

  /** One batch of the activity log: its own transaction, with the flag its trigger asks for. */
  private deleteActivityBatch(sql: string, params: number[]): Promise<{ n: number }[]> {
    return this.dataSource.transaction(async (manager) => {
      await manager.query(`SET LOCAL chumbaq.activity_retention = 'on'`);
      return (await manager.query(sql, params)) as { n: number }[];
    });
  }
}

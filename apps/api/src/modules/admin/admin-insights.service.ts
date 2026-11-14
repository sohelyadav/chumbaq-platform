import { readClock } from './clock';
import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { InjectEntityManager } from '@nestjs/typeorm';
import { Queue } from 'bullmq';
import { EntityManager } from 'typeorm';
import type { AdminHealth, AdminOverview } from '@chumbaq/shared';
import {
  QUEUE_COHORT_SYNC,
  QUEUE_PUSH_CAMPAIGN,
  QUEUE_SEGMENT_MATERIALIZE,
} from '../../queue/queue.constants';
import { PlatformEmailService } from '../platform-email/platform-email.service';
import { addDays } from '../usage/usage-days';
import { AdminUsageService, USAGE_WINDOW_DAYS } from './admin-usage.service';

export const HEALTH_CHECK_TIMEOUT_MS = 2000;

/** Counted days in the overview's usage chart. */
export const USAGE_TREND_DAYS = 90;

/**
 * First instant of the 30-day window, as a plain `timestamp` in the session's zone.
 *
 * `users.created_at` and `click_events.clicked_at` are `timestamp` columns filled
 * by `now()`, so they hold session-local wall clock (Asia/Kolkata on dev), not UTC.
 * Casting to timestamptz recovers the instant; comparing or grouping the raw column
 * against UTC days would be wrong by the session's offset.
 */
const WINDOW_START_SQL = `
  ((date_trunc('day', now() AT TIME ZONE 'UTC') - INTERVAL '29 days')
    AT TIME ZONE 'UTC')::timestamp`;

// click_events is indexed on (link_id, clicked_at) and not on clicked_at alone, so
// a plain range count scans the whole table. Counting per link stays inside that
// index and reads only entries in the window.
const TOTALS_SQL = `
  SELECT
    u.total,
    u.suspended,
    (SELECT count(*) FROM projects) AS projects,
    (SELECT count(*) FROM links) AS links,
    (SELECT count(*) FROM device_identities) AS identities,
    (SELECT COALESCE(sum(c.clicks), 0)
       FROM links l
       CROSS JOIN LATERAL (
         SELECT count(*) AS clicks
         FROM click_events ce
         WHERE ce.link_id = l.id AND ce.clicked_at >= ${WINDOW_START_SQL}
       ) c) AS clicks
  FROM (
    SELECT count(*) AS total,
           count(*) FILTER (WHERE suspended_at IS NOT NULL) AS suspended
    FROM users
  ) u`;

const SIGNUPS_SQL = `
  SELECT to_char(d.day, 'YYYY-MM-DD') AS date, COALESCE(s.count, 0) AS count
  FROM generate_series(
    date_trunc('day', now() AT TIME ZONE 'UTC') - INTERVAL '29 days',
    date_trunc('day', now() AT TIME ZONE 'UTC'),
    INTERVAL '1 day'
  ) AS d(day)
  LEFT JOIN (
    SELECT (created_at::timestamptz AT TIME ZONE 'UTC')::date AS day, count(*) AS count
    FROM users
    WHERE created_at >= ${WINDOW_START_SQL}
    GROUP BY 1
  ) s ON s.day = d.day::date
  ORDER BY d.day`;

type CheckResult<T> = { ok: true; value: T; latencyMs: number } | { ok: false };

@Injectable()
export class AdminInsightsService {
  private readonly logger = new Logger(AdminInsightsService.name);
  private readonly queues: Queue[];

  constructor(
    @InjectEntityManager() private readonly manager: EntityManager,
    @InjectQueue(QUEUE_PUSH_CAMPAIGN) pushQueue: Queue,
    @InjectQueue(QUEUE_COHORT_SYNC) cohortQueue: Queue,
    @InjectQueue(QUEUE_SEGMENT_MATERIALIZE) segmentQueue: Queue,
    private readonly platformEmail: PlatformEmailService,
    private readonly usage: AdminUsageService,
  ) {
    this.queues = [pushQueue, cohortQueue, segmentQueue];
  }

  /**
   * Every account counts as a tenant, super admins included: nothing is excluded,
   * so `active + suspended === total`. All "last 30 days" figures share one window,
   * today and the 29 UTC days before it, so `newLast30d` is the sum of `signupsByDay`.
   */
  async overview(): Promise<AdminOverview> {
    const [totals] = await this.manager.query(TOTALS_SQL);
    const signups = await this.manager.query(SIGNUPS_SQL);
    const usage = await this.usageOverview();

    // count() is a bigint, which the driver returns as a string.
    const signupsByDay = (signups as { date: string; count: string }[]).map((row) => ({
      date: row.date,
      count: Number(row.count),
    }));
    const total = Number(totals.total);
    const suspended = Number(totals.suspended);

    return {
      tenants: {
        total,
        active: total - suspended,
        suspended,
        newLast30d: signupsByDay.reduce((sum, day) => sum + day.count, 0),
      },
      projects: Number(totals.projects),
      links: Number(totals.links),
      identities: Number(totals.identities),
      clicksLast30d: Number(totals.clicks),
      signupsByDay,
      ...usage,
    };
  }

  /**
   * Usage across every tenant, from the roll-up's closed days only: unlike the
   * figures above, its 30 days end on the last counted day, not today.
   */
  private async usageOverview(): Promise<
    Pick<AdminOverview, 'usageCoverage' | 'usage30d' | 'usageTrend' | 'topTenants' | 'quietTenants'>
  > {
    const coverage = await this.usage.coverage();
    const through = coverage?.countedThrough;
    if (!coverage || !through) {
      return {
        usageCoverage: coverage,
        usage30d: null,
        usageTrend: [],
        topTenants: [],
        quietTenants: { count: 0, tenants: [] },
      };
    }
    const [totals, usageTrend, topTenants, quietTenants] = await Promise.all([
      this.usage.totals(coverage, null, addDays(through, -(USAGE_WINDOW_DAYS - 1)), through),
      this.usage.series(coverage, null, USAGE_TREND_DAYS),
      this.usage.topTenants(coverage),
      this.usage.quietTenants(coverage),
    ]);
    return { usageCoverage: coverage, usage30d: totals?.values ?? null, usageTrend, topTenants, quietTenants };
  }

  /**
   * Never rejects and never outlasts the check timeouts. Queue counts are omitted,
   * not zeroed, when they cannot be read: zero would claim an idle queue.
   */
  async health(): Promise<AdminHealth> {
    const [database, { redis, queues, queuesOk }, clock] = await Promise.all([
      this.runCheck('database', () => this.manager.query('SELECT 1')),
      this.checkRedisAndQueues(),
      readClock(),
    ]);

    return {
      status: database.ok && redis.ok && queuesOk ? 'ok' : 'degraded',
      checkedAt: new Date().toISOString(),
      database: toHealthEntry(database),
      redis: toHealthEntry(redis),
      platformEmail: {
        configured: this.platformEmail.isConfigured,
        from: this.platformEmail.sender?.email ?? null,
      },
      clock,
      queues,
    };
  }

  private async checkRedisAndQueues() {
    const redis = await this.runCheck('redis', async () => {
      // All three queues share one server, so any queue's client answers for Redis.
      const client = await this.queues[0].client;
      // BullMQ sets maxRetriesPerRequest to null, so a command sent while
      // disconnected waits in ioredis's offline queue for as long as the outage
      // lasts. Don't add one per health poll.
      if (client.status !== 'ready') throw new Error(`client is ${client.status}`);
      // BullMQ's IRedisClient type omits ping; the instance is always ioredis.
      return (client as unknown as { ping(): Promise<string> }).ping();
    });
    if (!redis.ok) return { redis, queues: [], queuesOk: false };

    const results = await Promise.all(
      this.queues.map(async (queue) => {
        const counts = await this.runCheck(`queue ${queue.name}`, () =>
          queue.getJobCounts('waiting', 'active', 'delayed', 'failed'),
        );
        return counts.ok ? { queue, counts: counts.value } : null;
      }),
    );

    return {
      redis,
      queues: results.flatMap((result) =>
        result
          ? [
              {
                name: result.queue.name,
                waiting: result.counts.waiting ?? 0,
                active: result.counts.active ?? 0,
                delayed: result.counts.delayed ?? 0,
                failed: result.counts.failed ?? 0,
              },
            ]
          : [],
      ),
      queuesOk: results.every((result) => result !== null),
    };
  }

  /**
   * Bounds a check that may never settle. The abandoned work is left to finish on
   * its own; Promise.race has already attached a handler, so a late rejection is
   * not unhandled. Error detail goes to the log only, since driver messages can
   * name hosts and credentials.
   */
  private async runCheck<T>(name: string, check: () => Promise<T>): Promise<CheckResult<T>> {
    const startedAt = Date.now();
    let timer: NodeJS.Timeout | undefined;
    try {
      const value = await Promise.race([
        check(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`timed out after ${HEALTH_CHECK_TIMEOUT_MS}ms`)),
            HEALTH_CHECK_TIMEOUT_MS,
          );
        }),
      ]);
      return { ok: true, value, latencyMs: Date.now() - startedAt };
    } catch (error) {
      this.logger.warn(`Health check "${name}" failed: ${(error as Error).message}`);
      return { ok: false };
    } finally {
      clearTimeout(timer);
    }
  }
}

function toHealthEntry(result: CheckResult<unknown>): AdminHealth['database'] {
  return result.ok
    ? { ok: true, latencyMs: result.latencyMs }
    : { ok: false, latencyMs: null };
}

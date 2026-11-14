import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource, EntityManager } from 'typeorm';
import type { BillingConfig } from '../../config/billing.config';
import { readUsageCoverage } from '../usage/usage-rollup.service';
import { BillingEmailsService } from './billing-emails.service';
import { BILLING_STATE_JOINS, effectivePlanCodeSql } from './effective-plan-sql';

/**
 * Each account's MAU on the last counted day (the sum of its projects'
 * month-to-date counts) against its effective plan's MAU limit, for accounts at
 * `minPercent` of it or more. `$1` is the counted day, `$2` now (for the plan).
 * Yields `owner_id, plan_code, plan_name, mau, mau_limit`. Accounts on a plan with
 * no MAU limit never appear.
 */
export function tenantMauOverLimitSql(minPercent: 80 | 100): string {
  return `
    WITH mau AS (
      SELECT owner_id, SUM(value)::bigint AS mau
        FROM usage_daily
       WHERE day = $1 AND metric = 'mau_month_to_date'
       GROUP BY owner_id
    )
    SELECT u.id AS owner_id, ep.code AS plan_code, ep.name AS plan_name, mau.mau, ep.mau_limit
      FROM mau
      JOIN users u ON u.id = mau.owner_id
      ${BILLING_STATE_JOINS}
      JOIN plans ep ON ep.code = ${effectivePlanCodeSql('$2')}
     WHERE ep.mau_limit IS NOT NULL
       AND mau.mau * 100 >= ep.mau_limit::bigint * ${minPercent}`;
}

/**
 * Emails an account's owner when its apps reach 80% and then 100% of its plan's
 * monthly active devices: once per level per month. Daily, after the usage roll-up.
 * Only with billing on (no plan limits otherwise), and only once the roll-up covers
 * active devices.
 *
 * Each notice is claimed before it is sent, by one conditional UPDATE of the
 * account's last notice (month and level), so two workers, or a run repeated the
 * same day, send it once. Sending second means a failed send is not retried: the
 * stamp stays, and it is counted as skipped. Limits are soft: the email says
 * nothing is blocked.
 */
@Injectable()
export class MauNoticesService {
  private readonly logger = new Logger(MauNoticesService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly config: ConfigService,
    private readonly emails: BillingEmailsService,
  ) {}

  async runOnce(
    now: Date = new Date(),
    manager: EntityManager = this.dataSource.manager,
  ): Promise<{ sent: number; skipped: number }> {
    const counts = { sent: 0, skipped: 0 };
    if (this.config.get<BillingConfig>('billing')?.enabled !== true) return counts;
    const coverage = await readUsageCoverage(manager);
    if (!coverage?.countedThrough || coverage.countedThrough < coverage.mauFrom) return counts;
    const month = `${coverage.countedThrough.slice(0, 7)}-01`;

    const rows: Array<{ owner_id: string; plan_name: string; mau: string; mau_limit: number }> = await manager.query(
      tenantMauOverLimitSql(80),
      [coverage.countedThrough, now],
    );
    for (const row of rows) {
      const mau = Number(row.mau);
      const level: 80 | 100 = mau >= row.mau_limit ? 100 : 80;
      await manager.query(`INSERT INTO billing_accounts (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING`, [
        row.owner_id,
      ]);
      const [, affected] = await manager.query(
        `UPDATE billing_accounts SET mau_notice_month = $2, mau_notice_level = $3, updated_at = now()
          WHERE user_id = $1 AND (mau_notice_month IS DISTINCT FROM $2::date OR mau_notice_level < $3)`,
        [row.owner_id, month, level],
      );
      if (affected !== 1) continue;
      const sent = await this.emails
        .mauNotice(row.owner_id, { level, mau, limit: row.mau_limit, planName: row.plan_name, month })
        .catch((error: Error) => {
          this.logger.warn(`MAU notice failed: ${error.name}`);
          return false;
        });
      if (sent) counts.sent += 1;
      else counts.skipped += 1;
    }
    return counts;
  }
}

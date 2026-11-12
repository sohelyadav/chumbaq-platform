import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import type { SecurityAlertKind, SecurityAlertView } from '@chumbaq/shared';
import { PlatformEmailService } from '../platform-email/platform-email.service';
import { alertEmail } from './alert-email';
import { emailAllStaff } from './staff-mail';

/** Repeats of one alarm (same kind and key) inside this window add to its count. */
export const ALERT_WINDOW_MINUTES = 15;

const MAX_KEY_LENGTH = 200;

interface AlertRow {
  id: string;
  kind: SecurityAlertKind;
  dedupe_key: string;
  details: Record<string, string | number | null>;
  ip_address: string | null;
  first_at: Date;
  last_at: Date;
  count: number;
  emailed_at: Date | null;
  email_failed: boolean;
}

/**
 * Raises security alarms: records each in `security_alerts` and emails every active
 * staff member, at most once per alarm per 15 minutes. Called from request paths (a
 * tripwire, a sign-in), so `raise` never throws: an alarm that cannot be recorded is
 * logged, and the request goes on as it would have.
 */
@Injectable()
export class SecurityAlertsService {
  private readonly logger = new Logger(SecurityAlertsService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly email: PlatformEmailService,
    private readonly config: ConfigService,
  ) {}

  async raise(
    kind: SecurityAlertKind,
    key: string,
    details: Record<string, string | number | null>,
    ip: string | null = null,
  ): Promise<void> {
    try {
      const dedupeKey = key.slice(0, MAX_KEY_LENGTH);
      const opened = await this.dataSource.transaction(async (manager) => {
        // Two first raises at once would each find no open window and both insert.
        await manager.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`security_alert:${kind}:${dedupeKey}`]);
        const [open] = await manager.query(
          `SELECT id FROM security_alerts
            WHERE kind = $1 AND dedupe_key = $2
              AND first_at > now() - make_interval(mins => $3)
            ORDER BY first_at DESC LIMIT 1 FOR UPDATE`,
          [kind, dedupeKey, ALERT_WINDOW_MINUTES],
        );
        if (open) {
          await manager.query(`UPDATE security_alerts SET count = count + 1, last_at = now() WHERE id = $1`, [open.id]);
          return null;
        }
        const [row] = await manager.query(
          `INSERT INTO security_alerts (kind, dedupe_key, details, ip_address)
           VALUES ($1, $2, $3, $4) RETURNING id, first_at`,
          [kind, dedupeKey, JSON.stringify(details), ip],
        );
        return row as { id: string; first_at: Date };
      });
      if (opened) await this.notifyStaff(opened.id, kind, details, ip, opened.first_at);
    } catch (error) {
      this.logger.error(`Could not raise security alarm ${kind}: ${(error as Error).message}`);
    }
  }

  /** Emails every active staff member; records whether any email went and whether any failed. */
  private async notifyStaff(
    id: string,
    kind: SecurityAlertKind,
    details: Record<string, string | number | null>,
    ip: string | null,
    at: Date,
  ): Promise<void> {
    const message = alertEmail({
      kind,
      details,
      ip,
      at,
      adminAppUrl: this.config.get<string>('ADMIN_APP_URL') || null,
    });
    const { anySent, anyFailed } = await emailAllStaff(this.dataSource, this.email, message);
    if (anyFailed) this.logger.warn(`Security alarm ${kind} could not be emailed to every staff member`);
    await this.dataSource.query(
      `UPDATE security_alerts SET emailed_at = ${anySent ? 'now()' : 'NULL'}, email_failed = $2 WHERE id = $1`,
      [id, anyFailed],
    );
  }

  /** Newest alarms first, for the Incidents page. */
  async list(limit: number): Promise<SecurityAlertView[]> {
    const rows: AlertRow[] = await this.dataSource.query(
      `SELECT * FROM security_alerts ORDER BY first_at DESC, id DESC LIMIT $1`,
      [Math.min(Math.max(limit, 1), 500)],
    );
    return rows.map((r) => ({
      id: r.id,
      kind: r.kind,
      key: r.dedupe_key,
      details: r.details,
      ip: r.ip_address,
      firstAt: r.first_at.toISOString(),
      lastAt: r.last_at.toISOString(),
      count: r.count,
      emailedAt: r.emailed_at ? r.emailed_at.toISOString() : null,
      emailFailed: r.email_failed,
    }));
  }
}

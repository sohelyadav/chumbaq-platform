import { Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { deviceFamily } from '../auth/sessions.service';
import { SecurityAlertsService } from '../security-alerts/security-alerts.service';

/** Failed staff sign-ins (by email or by address) within this many minutes ... */
export const STAFF_FAILURE_WINDOW_MINUTES = 15;
/** ... that raise `staff.failed_sign_ins` once there are this many. */
export const STAFF_FAILURE_ALARM_AT = 5;

/** How many earlier staff sessions a sign-in's device is compared with. */
const DEVICE_HISTORY_LIMIT = 50;

/**
 * The staff account alarms: a sign-in from a device that staff member has not used
 * before, and repeated failed sign-ins for one email or from one address. Failures are
 * counted from `admin_audit_logs` (`staff.sign_in_failed`, every failed factor), so the
 * count is the audit trail's and survives restarts.
 */
@Injectable()
export class StaffAlarmsService {
  private readonly logger = new Logger(StaffAlarmsService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly alerts: SecurityAlertsService,
  ) {}

  /** `signedIn`, not awaited: sign-in never waits on, or fails because of, an alarm. */
  signedInLater(
    user: { id: string; email: string },
    sessionId: string,
    context: { ipAddress?: string | null; userAgent?: string | null },
  ): void {
    this.signedIn(user, sessionId, context).catch((error: Error) =>
      this.logger.error(`Staff new-device check failed: ${error.message}`),
    );
  }

  /** `failed`, not awaited, for the same reason. */
  failedLater(email: string, ip: string | null): void {
    this.failed(email, ip).catch((error: Error) => this.logger.error(`Staff failure count failed: ${error.message}`));
  }

  async signedIn(
    user: { id: string; email: string },
    sessionId: string,
    context: { ipAddress?: string | null; userAgent?: string | null },
  ): Promise<void> {
    const device = deviceFamily(context.userAgent);
    if (!device) return;
    const earlier: { user_agent: string | null }[] = await this.dataSource.query(
      `SELECT user_agent FROM staff_sessions WHERE user_id = $1 AND id <> $2 ORDER BY created_at DESC LIMIT $3`,
      [user.id, sessionId, DEVICE_HISTORY_LIMIT],
    );
    // A first-ever sign-in has nothing to compare with, as on the customer side.
    if (earlier.length === 0) return;
    if (earlier.some((s) => deviceFamily(s.user_agent) === device)) return;
    await this.alerts.raise(
      'staff.new_device',
      `${user.id}:${device}`,
      { email: user.email, device },
      context.ipAddress ?? null,
    );
  }

  async failed(email: string, ip: string | null): Promise<void> {
    const [counts] = await this.dataSource.query(
      `SELECT count(*) FILTER (WHERE target_label = $1)::int AS by_email,
              count(*) FILTER (WHERE $2::text IS NOT NULL AND ip_address = $2)::int AS by_ip
         FROM admin_audit_logs
        WHERE action = 'staff.sign_in_failed'
          AND created_at > now() - make_interval(mins => $3)
          AND (target_label = $1 OR ip_address = $2)`,
      [email, ip, STAFF_FAILURE_WINDOW_MINUTES],
    );
    if (counts.by_email >= STAFF_FAILURE_ALARM_AT) {
      await this.alerts.raise('staff.failed_sign_ins', `email:${email}`, { email, failures: counts.by_email }, ip);
    }
    if (ip && counts.by_ip >= STAFF_FAILURE_ALARM_AT) {
      await this.alerts.raise('staff.failed_sign_ins', `ip:${ip}`, { ip, failures: counts.by_ip }, ip);
    }
  }
}

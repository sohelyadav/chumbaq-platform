import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { DataSource } from 'typeorm';
import { PlatformEmailService } from '../platform-email/platform-email.service';
import { emailAllStaff } from '../security-alerts/staff-mail';
import { reminderEmail } from './incident-emails';
import { dueReminders, REPORT_WITHIN_HOURS, type ReminderSlot } from './incident-report';

interface OpenIncident {
  id: string;
  title: string;
  status: 'open';
  noticed_at: Date;
  recorded_at: Date;
  reminder_4h_at: Date | null;
  reminder_5h_at: Date | null;
}

const COLUMN: Record<ReminderSlot, string> = { '4h': 'reminder_4h_at', '5h': 'reminder_5h_at' };
/** Sending the 5-hour reminder also settles the 4-hour one, which is no longer news. */
const SET: Record<ReminderSlot, string> = {
  '4h': 'reminder_4h_at = now()',
  '5h': 'reminder_4h_at = COALESCE(reminder_4h_at, now()), reminder_5h_at = now()',
};

/**
 * Reminds staff at 4 and 5 hours after an incident was noticed, while it is not marked
 * reported. Runs in the worker once a minute from the table itself, so a lost queue or a
 * restart cannot lose a reminder. Each reminder is claimed (its column stamped) before it
 * is sent, so two workers never both send it.
 */
@Injectable()
export class IncidentRemindersScheduler {
  private readonly logger = new Logger(IncidentRemindersScheduler.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly email: PlatformEmailService,
    private readonly config: ConfigService,
  ) {}

  @Cron(CronExpression.EVERY_MINUTE)
  async handle(): Promise<void> {
    try {
      await this.sendDue();
    } catch (error) {
      this.logger.error(`Incident reminders failed: ${(error as Error).message}`);
    }
  }

  async sendDue(now = new Date()): Promise<void> {
    const open: OpenIncident[] = await this.dataSource.query(
      `SELECT id, title, status, noticed_at, recorded_at, reminder_4h_at, reminder_5h_at
         FROM security_incidents
        WHERE status = 'open' AND noticed_at > $1::timestamptz - make_interval(hours => $2)
          AND (reminder_4h_at IS NULL OR reminder_5h_at IS NULL)`,
      [now, REPORT_WITHIN_HOURS],
    );
    for (const incident of open) {
      const due = dueReminders(
        {
          status: incident.status,
          noticedAt: incident.noticed_at,
          reminder4hAt: incident.reminder_4h_at,
          reminder5hAt: incident.reminder_5h_at,
        },
        now,
        incident.recorded_at,
      );
      // Only the latest: at 5.5 hours the 4-hour reminder is no longer news.
      const slot = due.at(-1);
      if (!slot) continue;
      const [claimed] = await this.dataSource.query(
        `UPDATE security_incidents
            SET ${SET[slot]}
          WHERE id = $1 AND status = 'open' AND ${COLUMN[slot]} IS NULL
          RETURNING id`,
        [incident.id],
      );
      if (!claimed?.length) continue;
      const { anyFailed } = await emailAllStaff(
        this.dataSource,
        this.email,
        reminderEmail({ id: incident.id, title: incident.title, noticedAt: incident.noticed_at }, slot, this.config.get<string>('ADMIN_APP_URL') || null),
      );
      if (anyFailed) {
        await this.dataSource.query(`UPDATE security_incidents SET reminder_email_failed = true WHERE id = $1`, [incident.id]);
        this.logger.warn(`Incident ${incident.id}: the ${slot} reminder could not be emailed to every staff member`);
      }
    }
  }
}

import { istAndUtc } from '../security-alerts/alert-email';
import { linesToHtml } from '../security-alerts/staff-mail';
import type { PlatformEmail } from '../platform-email/platform-email.service';
import { deadlineOf, type ReminderSlot } from './incident-report';

const pageOf = (adminAppUrl: string | null, id: string) =>
  adminAppUrl ? `${adminAppUrl.replace(/\/+$/, '')}/incidents/${id}` : `Incidents page, incident ${id}`;

/** Sent to every staff member when an incident is recorded. */
export function recordedEmail(
  incident: { id: string; title: string; noticedAt: Date },
  adminAppUrl: string | null,
): Omit<PlatformEmail, 'to'> {
  const deadline = deadlineOf(incident.noticedAt);
  const lines = [
    `An incident was recorded: ${incident.title}.`,
    `Noticed: ${istAndUtc(incident.noticedAt)}`,
    `Report to CERT-In by: ${istAndUtc(deadline)}`,
    '',
    'If it is one of the types CERT-In lists, report it within 6 hours of noticing it,',
    'even if the details are not all known yet. The Incidents page drafts the report.',
    pageOf(adminAppUrl, incident.id),
  ];
  return {
    subject: `Incident recorded: ${incident.title} (report to CERT-In by ${istAndUtc(deadline)})`,
    text: lines.join('\n'),
    html: linesToHtml(lines),
  };
}

/** The 4-hour and 5-hour reminders while an incident is not marked reported. */
export function reminderEmail(
  incident: { id: string; title: string; noticedAt: Date },
  slot: ReminderSlot,
  adminAppUrl: string | null,
): Omit<PlatformEmail, 'to'> {
  const left = slot === '4h' ? '2 hours' : '1 hour';
  const lines = [
    `${left} left to report "${incident.title}" to CERT-In.`,
    `Deadline: ${istAndUtc(deadlineOf(incident.noticedAt))}`,
    '',
    'Send what is known now (email incident@cert-in.org.in, phone 1800-11-4949), then mark it',
    'reported on the Incidents page. If it turned out not to be reportable, close it with a note.',
    pageOf(adminAppUrl, incident.id),
  ];
  return { subject: `${left} left to report: ${incident.title}`, text: lines.join('\n'), html: linesToHtml(lines) };
}

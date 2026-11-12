import type { CertInIncidentType, IncidentStatus, SecurityContact } from '@chumbaq/shared';
import { istAndUtc } from '../security-alerts/alert-email';
import { annexureLabel } from './annexure-i';

const HOUR_MS = 3600_000;

/** CERT-In: report "within 6 hours of noticing such incidents or being brought to notice". */
export const REPORT_WITHIN_HOURS = 6;
/** Hours after noticing when staff are reminded, while it is not marked reported. */
export const REMINDER_HOURS = { '4h': 4, '5h': 5 } as const;
export type ReminderSlot = keyof typeof REMINDER_HOURS;

export function deadlineOf(noticedAt: Date): Date {
  return new Date(noticedAt.getTime() + REPORT_WITHIN_HOURS * HOUR_MS);
}

/**
 * Reminders due now: each slot whose time has come, not yet sent, while the incident is
 * open. A slot that had already passed when the incident was recorded is skipped: the
 * page shows it overdue, and the email sent on recording already said so.
 */
export function dueReminders(
  incident: { status: IncidentStatus; noticedAt: Date; reminder4hAt: Date | null; reminder5hAt: Date | null },
  now: Date,
  recordedAt?: Date,
): ReminderSlot[] {
  if (incident.status !== 'open') return [];
  const sent = { '4h': incident.reminder4hAt, '5h': incident.reminder5hAt };
  return (Object.keys(REMINDER_HOURS) as ReminderSlot[]).filter((slot) => {
    const at = incident.noticedAt.getTime() + REMINDER_HOURS[slot] * HOUR_MS;
    return !sent[slot] && now.getTime() >= at && (!recordedAt || recordedAt.getTime() <= at);
  });
}

const isoSeconds = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, 'Z');

/**
 * The command that gathers this incident's logs: 24 hours before noticing until now.
 * The root-owned copy deploy-setup.sh installs, never the one in the app's directory.
 */
export const COLLECT_LOGS_COMMAND = 'sudo /usr/local/sbin/chumbaq-collect-logs';

export function logCommand(noticedAt: Date, now: Date): string {
  const from = new Date(noticedAt.getTime() - 24 * HOUR_MS);
  return `${COLLECT_LOGS_COMMAND} --from ${isoSeconds(from)} --to ${isoSeconds(now)}`;
}

export interface DraftIncident {
  title: string;
  types: CertInIncidentType[];
  noticedAt: Date;
  howNoticed: string;
  summary: string;
  systems: string;
  tenantCount: number;
  notes: { at: Date; note: string }[];
}

export type DraftContact = Omit<SecurityContact, 'updatedAt'>;

const fill = (value: string | null | undefined) => (value && value.trim() ? value.trim() : '[to fill]');

const IST_OFFSET_MS = 330 * 60_000;
const pad = (n: number) => String(n).padStart(2, '0');

/** dd/mm/yyyy hh:mm in IST, the format of CERT-In's incident reporting form. */
export function formDateIst(d: Date): string {
  const ist = new Date(d.getTime() + IST_OFFSET_MS);
  return `${pad(ist.getUTCDate())}/${pad(ist.getUTCMonth() + 1)}/${ist.getUTCFullYear()} ${pad(ist.getUTCHours())}:${pad(ist.getUTCMinutes())} IST`;
}

/**
 * The email to CERT-In (incident@cert-in.org.in), in the order of their incident
 * reporting form, filled from the incident. Staff read it, complete the `[to fill]`
 * parts, and send it themselves: nothing is ever sent to CERT-In automatically.
 */
export function buildReportDraft(incident: DraftIncident, contact: DraftContact | null): { subject: string; body: string } {
  const c = contact ?? ({} as Partial<DraftContact>);
  const lines = [
    'To: incident@cert-in.org.in',
    '',
    'I am: the affected entity',
    '',
    'Reporting organisation',
    `Organisation: ${fill(c.orgName)}`,
    `Address: ${fill(c.orgAddress)}`,
    `Sector: ${fill(c.sector)}`,
    '',
    'Point of contact',
    `Name: ${fill(c.pocName)}`,
    `Designation: ${fill(c.pocRole)}`,
    `Email: ${fill(c.pocEmail)}`,
    `Phone: ${fill(c.pocPhone)}`,
    '',
    'Incident',
    `Title: ${incident.title}`,
    `Type (CERT-In Directions of 28 April 2022, Annexure I):`,
    ...incident.types.map((id) => `  (${id}) ${annexureLabel(id)}`),
    `Noticed at: ${istAndUtc(incident.noticedAt)}`,
    `How it came to notice: ${fill(incident.howNoticed)}`,
    `Systems affected: ${fill(incident.systems)}`,
    `Customer accounts affected: ${incident.tenantCount}`,
    `Occurrence date & time (dd/mm/yyyy hh:mm): [to fill]`,
    `Detection date & time (dd/mm/yyyy hh:mm): ${formDateIst(incident.noticedAt)}`,
    `Is the affected system critical to the organisation's mission? (Yes/No, brief details): [to fill]`,
    '',
    'Basic information of affected system',
    'Domain/URL: [to fill]',
    'IP address: [to fill]',
    'Operating system: [to fill]',
    'Make/Model/Cloud details: [to fill]',
    `Affected application details: ${fill(incident.systems)}`,
    'Location of affected system (city, region, country): [to fill]',
    'Network and name of ISP: [to fill]',
    '',
    'Description',
    fill(incident.summary),
    '',
    'Actions taken so far',
    ...(incident.notes.length
      ? incident.notes.map((n) => `- ${istAndUtc(n.at)}: ${n.note}`)
      : ['[to fill]']),
    '',
    'Logs',
    'Logs covering the period are preserved and will be provided with this report or on request.',
    '',
    'This is an initial report within 6 hours of noticing, as direction (ii) requires; further details will follow.',
  ];
  return { subject: `Cyber security incident report: ${incident.title}`, body: lines.join('\n') };
}

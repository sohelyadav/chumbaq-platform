import type { SecurityAlertKind } from '@chumbaq/shared';
import type { PlatformEmail } from '../platform-email/platform-email.service';
import { SECURITY_ALERT_LABELS } from './alert-kinds';

export interface AlertEmailInput {
  kind: SecurityAlertKind;
  details: Record<string, string | number | null>;
  ip: string | null;
  at: Date;
  adminAppUrl: string | null;
}

/** `11 Nov 2026, 14:05 IST (08:35 UTC)`. */
export function istAndUtc(at: Date): string {
  const ist = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata',
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(at);
  const utc = at.toISOString().slice(11, 16);
  return `${ist} IST (${utc} UTC)`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

/** The email every staff member gets for an alarm, without the recipient. */
export function alertEmail(input: AlertEmailInput): Omit<PlatformEmail, 'to'> {
  const label = SECURITY_ALERT_LABELS[input.kind];
  const lines = [
    `Security alarm: ${label}.`,
    `When: ${istAndUtc(input.at)}`,
    ...(input.ip ? [`From address: ${input.ip}`] : []),
    ...Object.entries(input.details).map(([k, v]) => `${k}: ${v ?? ''}`),
    '',
    'If this was not you or someone you expected, treat it as a possible incident: record it on the',
    'Incidents page now. CERT-In must be told within 6 hours of noticing an incident.',
    ...(input.adminAppUrl ? [`${input.adminAppUrl.replace(/\/+$/, '')}/incidents`] : []),
  ];
  const text = lines.join('\n');
  const html = lines.map((l) => (l ? `<p>${escapeHtml(l)}</p>` : '')).join('\n');
  return { subject: `Chumbaq security alarm: ${label}`, text, html };
}

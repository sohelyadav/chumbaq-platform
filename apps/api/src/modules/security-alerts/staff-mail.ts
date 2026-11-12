import type { DataSource } from 'typeorm';
import type { PlatformEmail, PlatformEmailService } from '../platform-email/platform-email.service';

/**
 * Emails every active staff member (super admins not suspended). `anyFailed` is also
 * true when there is nobody to email, so a page can say the email did not go.
 */
export async function emailAllStaff(
  dataSource: DataSource,
  email: PlatformEmailService,
  message: Omit<PlatformEmail, 'to'>,
): Promise<{ anySent: boolean; anyFailed: boolean }> {
  const staff: { email: string }[] = await dataSource.query(
    `SELECT email FROM users WHERE is_super_admin = true AND suspended_at IS NULL ORDER BY email`,
  );
  let anySent = false;
  let anyFailed = staff.length === 0;
  for (const { email: to } of staff) {
    const result = await email.send({ to, ...message }).catch(() => ({ sent: false as const }));
    if (result.sent) anySent = true;
    else anyFailed = true;
  }
  return { anySent, anyFailed };
}

/** Text lines as a plain HTML body, escaped. */
export function linesToHtml(lines: string[]): string {
  const escape = (v: string) =>
    v.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
  return lines.map((l) => (l ? `<p>${escape(l)}</p>` : '')).join('\n');
}

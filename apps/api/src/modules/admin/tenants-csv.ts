import type { AdminTenantStatus } from '@chumbaq/shared';
import { csvCell } from './audit-csv';

/**
 * The tenants list as staff download it: the account and its usage counts,
 * nothing about anyone the tenant messages.
 */
export const TENANT_CSV_HEADER = [
  'tenant_id',
  'email',
  'name',
  'status',
  'super_admin',
  'signed_up_at',
  'projects',
  'mau_this_month',
  'messages_sent_30d',
  'last_usage_day',
  'counted_through',
] as const;

/** Most rows one export holds, as for the audit log; the response says when it cut some off. */
export const TENANT_EXPORT_ROW_CAP = 10_000;

export interface TenantCsvRow {
  id: string;
  email: string;
  name: string;
  status: AdminTenantStatus;
  isSuperAdmin: boolean;
  createdAt: string;
  projectCount: number;
  mauThisMonth: number;
  messagesSent30d: number;
  lastUsageDay: string | null;
}

/** Every cell through `csvCell`: names and emails are typed by tenants, so a formula must stay text. */
function line(cells: (string | null)[]): string {
  return `${cells.map(csvCell).join(',')}\r\n`;
}

export function toTenantsCsv(rows: TenantCsvRow[], countedThrough: string | null): string {
  return (
    line([...TENANT_CSV_HEADER]) +
    rows
      .map((row) =>
        line([
          row.id,
          row.email,
          row.name,
          row.status,
          String(row.isSuperAdmin),
          row.createdAt,
          String(row.projectCount),
          String(row.mauThisMonth),
          String(row.messagesSent30d),
          row.lastUsageDay,
          countedThrough,
        ]),
      )
      .join('')
  );
}

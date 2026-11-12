import type { AdminAuditLog } from '@chumbaq/shared';

export const AUDIT_CSV_HEADER = [
  'created_at',
  'actor_email',
  'actor_id',
  'action',
  'target_type',
  'target_id',
  'target_label',
  'reason',
  'ip_address',
  'metadata',
  'id',
] as const;

/**
 * Spreadsheets run a cell starting with one of these as a formula, and reasons and
 * labels are free text a tenant can influence (their email is the target label),
 * so opening an export must never execute what someone typed.
 */
const FORMULA_START = /^[=+\-@\t\r]/;
const NEEDS_QUOTES = /[",\r\n]/;

/** One RFC 4180 cell, made inert for spreadsheets with a leading single quote. */
export function csvCell(value: string | null | undefined): string {
  if (value === null || value === undefined || value === '') return '';
  const safe = FORMULA_START.test(value) ? `'${value}` : value;
  return NEEDS_QUOTES.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

function line(cells: (string | null)[]): string {
  return `${cells.map(csvCell).join(',')}\r\n`;
}

export function toAuditCsv(rows: AdminAuditLog[]): string {
  return (
    line([...AUDIT_CSV_HEADER]) +
    rows
      .map((row) =>
        line([
          row.createdAt,
          row.actorEmail,
          row.actorId,
          row.action,
          row.targetType,
          row.targetId,
          row.targetLabel,
          row.reason,
          row.ipAddress,
          row.metadata ? JSON.stringify(row.metadata) : null,
          row.id,
        ]),
      )
      .join('')
  );
}

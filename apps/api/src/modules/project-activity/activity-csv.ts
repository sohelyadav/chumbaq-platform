import type { ProjectActivityEntry } from '@chumbaq/shared';
import { csvCell } from '../admin/audit-csv';

export const ACTIVITY_CSV_HEADER = [
  'occurred_at',
  'actor',
  'action',
  'target_type',
  'target_id',
  'target_label',
  'ip_address',
  'country',
  'user_agent',
  'details',
  'id',
] as const;

/** Every cell goes through `csvCell`, so a label someone typed cannot run as a formula. */
function line(cells: (string | null)[]): string {
  return `${cells.map(csvCell).join(',')}\r\n`;
}

/** The entries as RFC 4180 CSV, in the order given. Times are as the API gives them, UTC ISO 8601. */
export function toActivityCsv(rows: ProjectActivityEntry[]): string {
  return (
    line([...ACTIVITY_CSV_HEADER]) +
    rows
      .map((row) =>
        line([
          row.occurredAt,
          row.actorLabel,
          row.action,
          row.targetType,
          row.targetId,
          row.targetLabel,
          row.ipAddress,
          row.country,
          row.userAgent,
          row.details ? JSON.stringify(row.details) : null,
          row.id,
        ]),
      )
      .join('')
  );
}

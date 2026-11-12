import { createWriteStream } from 'fs';
import path from 'path';
import { once } from 'events';
import type { DataSource } from 'typeorm';
import { csvCell } from '../modules/admin/audit-csv';

/**
 * The database half of the CERT-In log bundle (scripts/collect-logs.sh runs this):
 * every log table's rows whose time is in [from, to), all columns, as CSV, one file
 * per table. Read in pages, so a large window never sits in memory.
 *
 *   npm run security:export-db-logs -w apps/api -- --from <ISO> --to <ISO> --out <dir>
 */
export const SECURITY_LOG_TABLES = [
  { table: 'auth_events', at: 'created_at' },
  { table: 'project_activity', at: 'occurred_at' },
  { table: 'admin_audit_logs', at: 'created_at' },
  { table: 'security_alerts', at: 'first_at' },
] as const;

const PAGE = 5000;

export interface Window {
  from: Date;
  to: Date;
}

export function parseWindow(from: string | undefined, to: string | undefined): Window {
  const parse = (name: string, value: string | undefined) => {
    const date = value && /^\d{4}-\d{2}-\d{2}T/.test(value) ? new Date(value) : new Date(NaN);
    if (Number.isNaN(date.getTime())) throw new Error(`${name} must be an ISO 8601 time, such as 2026-11-11T08:00:00Z`);
    return date;
  };
  const window = { from: parse('--from', from), to: parse('--to', to) };
  if (window.from >= window.to) throw new Error('--from must be before --to');
  return window;
}

function cell(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object') return csvCell(JSON.stringify(value));
  return csvCell(String(value));
}

export async function exportSecurityLogs(
  ds: DataSource,
  window: Window,
  outDir: string,
): Promise<{ table: string; file: string; rows: number }[]> {
  const written: { table: string; file: string; rows: number }[] = [];
  for (const { table, at } of SECURITY_LOG_TABLES) {
    const file = path.join(outDir, `${table}.csv`);
    const stream = createWriteStream(file, { mode: 0o600 });
    const columns: { column_name: string }[] = await ds.query(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = $1 ORDER BY ordinal_position`,
      [table],
    );
    const names = columns.map((c) => c.column_name);
    stream.write(`${names.map(csvCell).join(',')}\r\n`);
    let rows = 0;
    let after: { at: Date; id: string } | null = null;
    for (;;) {
      const page: Record<string, unknown>[] = await ds.query(
        `SELECT * FROM ${table}
          WHERE ${at} >= $1 AND ${at} < $2
            ${after ? `AND (${at}, id) > ($3, $4)` : ''}
          ORDER BY ${at}, id LIMIT ${PAGE}`,
        after ? [window.from, window.to, after.at, after.id] : [window.from, window.to],
      );
      for (const row of page) {
        if (!stream.write(`${names.map((n) => cell(row[n])).join(',')}\r\n`)) await once(stream, 'drain');
      }
      rows += page.length;
      if (page.length < PAGE) break;
      const last = page[page.length - 1];
      after = { at: last[at] as Date, id: String(last.id) };
    }
    stream.end();
    await once(stream, 'finish');
    written.push({ table, file, rows });
  }
  return written;
}

async function main(): Promise<void> {
  const arg = (name: string) => {
    const i = process.argv.indexOf(name);
    return i >= 0 ? process.argv[i + 1] : undefined;
  };
  let window: Window;
  try {
    window = parseWindow(arg('--from'), arg('--to'));
  } catch (error) {
    console.error((error as Error).message);
    process.exit(2);
  }
  const out = arg('--out') ?? process.cwd();
  const { default: dataSource } = await import('../data-source');
  await dataSource.initialize();
  try {
    for (const w of await exportSecurityLogs(dataSource, window, out)) console.log(`${w.table}: ${w.rows} rows -> ${w.file}`);
  } finally {
    await dataSource.destroy();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error((error as Error).message);
    process.exit(1);
  });
}

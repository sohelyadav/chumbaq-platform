import { Injectable } from '@nestjs/common';
import type { PersonExport } from '@chumbaq/shared';
import { ConfigService } from '@nestjs/config';
import { SecurityAlertsService } from './security-alerts.service';
import { VolumeWatch } from './volume-watch';

const HOUR_MS = 3600_000;
const TEN_MINUTES_MS = 600_000;

export const DEFAULT_BULK_EXPORT_ALERT_ROWS = 50_000;
export const DEFAULT_API_DOWNLOAD_ALERT_REQUESTS = 2_000;

function positiveInt(config: ConfigService, name: string, fallback: number): number {
  const raw = config.get<string>(name)?.toString().trim();
  if (!raw) return fallback;
  if (!/^\d+$/.test(raw) || Number(raw) < 1) {
    throw new Error(`${name} must be a positive whole number, not "${raw}"`);
  }
  return Number(raw);
}

/** Data rows in a CSV with a header line. */
export function countCsvRows(csv: string): number {
  const lines = csv.split('\n').filter((line) => line.length > 0);
  return Math.max(lines.length - 1, 0);
}

/** Rows a person export carries: every section's rows (what the file actually holds). */
export function countPersonExportRows(exported: PersonExport): number {
  return Object.values(exported.sections).reduce((n, section) => n + section.rows.length, 0);
}

/**
 * The bulk data alarms: an account exporting more than `BULK_EXPORT_ALERT_ROWS` rows in
 * an hour, or making more than `API_DOWNLOAD_ALERT_REQUESTS` reads in ten minutes. They
 * alarm only; nothing is blocked. Counts are per process and in memory (bounded), which
 * is exact for Chumbaq Cloud's single API process.
 */
@Injectable()
export class VolumeWatchService {
  private readonly exports: VolumeWatch;
  private readonly reads: VolumeWatch;
  private readonly exportLimit: number;
  private readonly readLimit: number;

  constructor(
    config: ConfigService,
    private readonly alerts: SecurityAlertsService,
  ) {
    this.exportLimit = positiveInt(config, 'BULK_EXPORT_ALERT_ROWS', DEFAULT_BULK_EXPORT_ALERT_ROWS);
    this.readLimit = positiveInt(config, 'API_DOWNLOAD_ALERT_REQUESTS', DEFAULT_API_DOWNLOAD_ALERT_REQUESTS);
    this.exports = new VolumeWatch(HOUR_MS, this.exportLimit);
    this.reads = new VolumeWatch(TEN_MINUTES_MS, this.readLimit);
  }

  /** Never awaited by callers: `raise` never throws, and the download must not wait on it. */
  exported(userId: string, projectId: string | null, rows: number, route: string): void {
    if (this.exports.add(userId, rows)) {
      void this.alerts.raise('data.bulk_export', userId, { rows: this.exportLimit, projectId, route });
    }
  }

  read(userId: string): void {
    if (this.reads.add(userId, 1)) {
      void this.alerts.raise('data.unusual_reads', userId, { requests: this.readLimit });
    }
  }
}

import { ConfigService } from '@nestjs/config';
import { of } from 'rxjs';
import type { CallHandler, ExecutionContext } from '@nestjs/common';
import type { SecurityAlertsService } from './security-alerts.service';
import type { PersonExport } from '@chumbaq/shared';
import { VolumeWatchService, countCsvRows, countPersonExportRows } from './volume-watch.service';
import { ReadVolumeInterceptor } from './read-volume.interceptor';

describe('VolumeWatchService', () => {
  const raise = jest.fn(async () => undefined);
  const alerts = { raise } as unknown as SecurityAlertsService;
  const make = (env: Record<string, string> = {}) => new VolumeWatchService(new ConfigService(env), alerts);

  beforeEach(() => raise.mockClear());

  it('raises data.bulk_export once an account passes the hourly row limit', () => {
    const watch = make({ BULK_EXPORT_ALERT_ROWS: '100' });
    watch.exported('u1', 'p1', 60, 'activity export');
    expect(raise).not.toHaveBeenCalled();
    watch.exported('u1', 'p2', 40, 'person export');
    expect(raise).toHaveBeenCalledWith('data.bulk_export', 'u1', { rows: 100, projectId: 'p2', route: 'person export' });
    watch.exported('u1', 'p2', 40, 'person export');
    expect(raise).toHaveBeenCalledTimes(1);
  });

  it('defaults to 50,000 rows and 2,000 reads', () => {
    const watch = make();
    watch.exported('u1', null, 49_999, 'x');
    expect(raise).not.toHaveBeenCalled();
    for (let i = 0; i < 1999; i++) watch.read('u2');
    expect(raise).not.toHaveBeenCalled();
    watch.read('u2');
    expect(raise).toHaveBeenCalledWith('data.unusual_reads', 'u2', { requests: 2000 });
  });

  it('refuses a limit that is not a positive whole number', () => {
    expect(() => make({ BULK_EXPORT_ALERT_ROWS: '0' })).toThrow(/BULK_EXPORT_ALERT_ROWS/);
    expect(() => make({ API_DOWNLOAD_ALERT_REQUESTS: 'lots' })).toThrow(/API_DOWNLOAD_ALERT_REQUESTS/);
  });

  it('counts CSV data rows and exported records', () => {
    expect(countCsvRows('a,b\n1,2\n3,4\n')).toBe(2);
    expect(countCsvRows('a,b')).toBe(0);
    expect(countCsvRows('')).toBe(0);
  });

  it('counts the rows a person export carries across its sections', () => {
    const section = (n: number) => ({ total: n, truncated: false, rows: Array.from({ length: n }, () => ({})) });
    const exported = {
      exportedAt: '2026-11-11T00:00:00Z',
      projectId: 'p',
      subject: { type: 'personId', value: 'x' },
      rowCapPerSection: 10000,
      truncated: false,
      notIncluded: ['a', 'b'],
      sections: { events: section(3), devices: section(2), clicks: section(0) },
    } as unknown as PersonExport;
    expect(countPersonExportRows(exported)).toBe(5);
  });
});

describe('ReadVolumeInterceptor', () => {
  const read = jest.fn();
  const interceptor = new ReadVolumeInterceptor({ read } as unknown as VolumeWatchService);
  const next: CallHandler = { handle: () => of('ok') };
  const ctx = (req: object) =>
    ({ getType: () => 'http', switchToHttp: () => ({ getRequest: () => req }) }) as unknown as ExecutionContext;

  beforeEach(() => read.mockClear());

  it('counts GETs by a signed-in dashboard user', () => {
    interceptor.intercept(ctx({ method: 'GET', user: { userId: 'u1' } }), next);
    expect(read).toHaveBeenCalledWith('u1');
  });

  it('ignores writes, API-key and anonymous requests', () => {
    interceptor.intercept(ctx({ method: 'POST', user: { userId: 'u1' } }), next);
    interceptor.intercept(ctx({ method: 'GET', apiKey: { id: 'k' } }), next);
    interceptor.intercept(ctx({ method: 'GET' }), next);
    expect(read).not.toHaveBeenCalled();
  });
});

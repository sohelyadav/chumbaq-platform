import { ForbiddenException } from '@nestjs/common';
import 'reflect-metadata';
import { PROJECT_PERMISSION_KEY } from '../project-access/require-project-permission.decorator';
import { AnalyticsController } from './analytics.controller';

const PROJECT = { param: 'projectId' };
const LINK = { resource: 'link', param: 'id' };

// handler -> [permission, project source]. The guard reads exactly this metadata.
const TABLE: Array<[keyof AnalyticsController, string, unknown]> = [
  ['getSummary', 'project.read', LINK],
  ['getTimeseries', 'project.read', LINK],
  ['getDeviceBreakdown', 'project.read', LINK],
  ['getGeoBreakdown', 'project.read', LINK],
  ['getReferrers', 'project.read', LINK],
  ['exportCsv', 'project.read', LINK],
  ['getProjectAnalyticsSummary', 'project.read', PROJECT],
  ['getProjectTimeseries', 'project.read', PROJECT],
  ['getProjectDeviceBreakdown', 'project.read', PROJECT],
  ['getProjectGeoBreakdown', 'project.read', PROJECT],
  ['getProjectReferrers', 'project.read', PROJECT],
  ['getProjectDashboardStats', 'project.read', PROJECT],
];

describe('AnalyticsController route permissions', () => {
  it.each(TABLE)('%s needs %s', (handler, permission, from) => {
    const metadata = Reflect.getMetadata(
      PROJECT_PERMISSION_KEY,
      (AnalyticsController.prototype as unknown as Record<string, object>)[handler as string],
    );
    expect(metadata).toEqual({ permission, from });
  });

  it('lists every handler', () => {
    const handlers = Object.getOwnPropertyNames(AnalyticsController.prototype).filter((n) => n !== 'constructor');
    expect(handlers.filter((n) => !Reflect.hasMetadata(PROJECT_PERMISSION_KEY, (AnalyticsController.prototype as any)[n])).sort())
      .toEqual(['getDashboardStats']);
    expect(TABLE.map(([h]) => h as string).sort()).toEqual(
      handlers.filter((n) => Reflect.hasMetadata(PROJECT_PERMISSION_KEY, (AnalyticsController.prototype as any)[n])).sort(),
    );
  });
});

describe('AnalyticsController click export', () => {
  it('is refused to staff viewing as the tenant, before anything is read', async () => {
    const service = { exportClicksAsCsv: jest.fn() };
    const controller = new AnalyticsController(service as never, { exported: jest.fn() } as never);
    const viewAs = { userId: 'u1', impersonatedBy: 'staff-1' } as never;

    await expect(controller.exportCsv('link-1', viewAs, {} as never)).rejects.toThrow(ForbiddenException);
    expect(service.exportClicksAsCsv).not.toHaveBeenCalled();
  });
});

import 'reflect-metadata';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { WidgetAnalyticsController } from './widget-analytics.controller';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { ProjectAccessGuard } from '../project-access/project-access.guard';
import { PROJECT_PERMISSION_KEY } from '../project-access/require-project-permission.decorator';

/** handler, permission, permission source */
const HANDLERS: Array<[string, string, object]> = [
    ['getSummary', 'project.read', { resource: 'bannerCategory', param: 'id' }],
    ['getTimeseries', 'project.read', { resource: 'bannerCategory', param: 'id' }],
    ['getDeviceBreakdown', 'project.read', { resource: 'bannerCategory', param: 'id' }],
    ['getGeoBreakdown', 'project.read', { resource: 'bannerCategory', param: 'id' }],
    ['getItemStats', 'project.read', { resource: 'bannerCategory', param: 'id' }],
];

describe('WidgetAnalyticsController route permissions', () => {
  it.each(HANDLERS)('%s requires %s from %j', (handler, permission, from) => {
    const meta = Reflect.getMetadata(PROJECT_PERMISSION_KEY, (WidgetAnalyticsController.prototype as unknown as Record<string, object>)[handler]);
    expect(meta).toEqual({ permission, from });
  });

  it('is JwtAuthGuard-first at class level', () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, WidgetAnalyticsController)).toEqual([JwtAuthGuard]);
  });

  it.each(HANDLERS.map(([handler]) => handler))('%s adds ProjectAccessGuard', (handler) => {
    expect(Reflect.getMetadata(GUARDS_METADATA, (WidgetAnalyticsController.prototype as unknown as Record<string, object>)[handler])).toEqual([ProjectAccessGuard]);
  });
});

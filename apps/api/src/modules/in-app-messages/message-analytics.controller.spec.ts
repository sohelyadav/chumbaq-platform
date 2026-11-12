import 'reflect-metadata';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { MessageAnalyticsController } from './message-analytics.controller';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { ProjectAccessGuard } from '../project-access/project-access.guard';
import { PROJECT_PERMISSION_KEY } from '../project-access/require-project-permission.decorator';

/** handler, permission, permission source */
const HANDLERS: Array<[string, string, object]> = [
    ['getSummary', 'project.read', { param: 'projectId' }],
    ['getFunnel', 'project.read', { param: 'projectId' }],
    ['getButtonBreakdown', 'project.read', { param: 'projectId' }],
    ['getTimeseries', 'project.read', { param: 'projectId' }],
    ['getPlatformBreakdown', 'project.read', { param: 'projectId' }],
];

describe('MessageAnalyticsController route permissions', () => {
  it.each(HANDLERS)('%s requires %s from %j', (handler, permission, from) => {
    const meta = Reflect.getMetadata(PROJECT_PERMISSION_KEY, (MessageAnalyticsController.prototype as unknown as Record<string, object>)[handler]);
    expect(meta).toEqual({ permission, from });
  });

  it('is JwtAuthGuard-first at class level', () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, MessageAnalyticsController)).toEqual([JwtAuthGuard]);
  });

  it.each(HANDLERS.map(([handler]) => handler))('%s adds ProjectAccessGuard', (handler) => {
    expect(Reflect.getMetadata(GUARDS_METADATA, (MessageAnalyticsController.prototype as unknown as Record<string, object>)[handler])).toEqual([ProjectAccessGuard]);
  });
});

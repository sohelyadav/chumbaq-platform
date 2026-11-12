import 'reflect-metadata';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { JourneysController } from './journeys.controller';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { ProjectAccessGuard } from '../project-access/project-access.guard';
import { PROJECT_PERMISSION_KEY } from '../project-access/require-project-permission.decorator';

/** handler, permission, permission source */
const HANDLERS: Array<[string, string, object]> = [
    ['list', 'project.read', { param: 'projectId' }],
    ['get', 'project.read', { param: 'projectId' }],
    ['stats', 'project.read', { param: 'projectId' }],
    ['create', 'messaging.write', { param: 'projectId' }],
    ['update', 'messaging.write', { param: 'projectId' }],
    ['setStatus', 'messaging.write', { param: 'projectId' }],
    ['remove', 'messaging.write', { param: 'projectId' }],
];

describe('JourneysController route permissions', () => {
  it.each(HANDLERS)('%s requires %s from %j', (handler, permission, from) => {
    const meta = Reflect.getMetadata(PROJECT_PERMISSION_KEY, (JourneysController.prototype as unknown as Record<string, object>)[handler]);
    expect(meta).toEqual({ permission, from });
  });

  it('is JwtAuthGuard-first at class level', () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, JourneysController)).toEqual([JwtAuthGuard]);
  });

  it.each(HANDLERS.map(([handler]) => handler))('%s adds ProjectAccessGuard', (handler) => {
    expect(Reflect.getMetadata(GUARDS_METADATA, (JourneysController.prototype as unknown as Record<string, object>)[handler])).toEqual([ProjectAccessGuard]);
  });
});

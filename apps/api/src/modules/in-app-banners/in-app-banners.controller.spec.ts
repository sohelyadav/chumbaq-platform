import 'reflect-metadata';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { InAppBannersController } from './in-app-banners.controller';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { ProjectAccessGuard } from '../project-access/project-access.guard';
import { PROJECT_PERMISSION_KEY } from '../project-access/require-project-permission.decorator';

/** handler, permission, permission source */
const HANDLERS: Array<[string, string, object]> = [
    ['create', 'messaging.write', { resource: 'bannerCategory', param: 'categoryId' }],
    ['findAll', 'project.read', { resource: 'bannerCategory', param: 'categoryId' }],
    ['findOne', 'project.read', { resource: 'banner', param: 'id' }],
    ['reorder', 'messaging.write', { resource: 'bannerCategory', param: 'categoryId' }],
    ['update', 'messaging.write', { resource: 'banner', param: 'id' }],
    ['remove', 'messaging.write', { resource: 'banner', param: 'id' }],
];

describe('InAppBannersController route permissions', () => {
  it.each(HANDLERS)('%s requires %s from %j', (handler, permission, from) => {
    const meta = Reflect.getMetadata(PROJECT_PERMISSION_KEY, (InAppBannersController.prototype as unknown as Record<string, object>)[handler]);
    expect(meta).toEqual({ permission, from });
  });

  it.each(HANDLERS.map(([handler]) => handler))(
    '$0 runs JwtAuthGuard before ProjectAccessGuard',
    (handler) => {
      const guards = Reflect.getMetadata(GUARDS_METADATA, (InAppBannersController.prototype as unknown as Record<string, object>)[handler]);
      expect(guards).toEqual([JwtAuthGuard, ProjectAccessGuard]);
    },
  );
});

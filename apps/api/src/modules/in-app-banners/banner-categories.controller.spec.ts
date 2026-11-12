import 'reflect-metadata';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { BannerCategoriesController } from './banner-categories.controller';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { ProjectAccessGuard } from '../project-access/project-access.guard';
import { PROJECT_PERMISSION_KEY } from '../project-access/require-project-permission.decorator';

/** handler, permission, permission source */
const HANDLERS: Array<[string, string, object]> = [
    ['create', 'messaging.write', { param: 'projectId' }],
    ['findAll', 'project.read', { param: 'projectId' }],
    ['findOne', 'project.read', { resource: 'bannerCategory', param: 'id' }],
    ['update', 'messaging.write', { resource: 'bannerCategory', param: 'id' }],
    ['updateStatus', 'messaging.write', { resource: 'bannerCategory', param: 'id' }],
    ['remove', 'messaging.write', { resource: 'bannerCategory', param: 'id' }],
];

describe('BannerCategoriesController route permissions', () => {
  it.each(HANDLERS)('%s requires %s from %j', (handler, permission, from) => {
    const meta = Reflect.getMetadata(PROJECT_PERMISSION_KEY, (BannerCategoriesController.prototype as unknown as Record<string, object>)[handler]);
    expect(meta).toEqual({ permission, from });
  });

  it.each(HANDLERS.map(([handler]) => handler))(
    '$0 runs JwtAuthGuard before ProjectAccessGuard',
    (handler) => {
      const guards = Reflect.getMetadata(GUARDS_METADATA, (BannerCategoriesController.prototype as unknown as Record<string, object>)[handler]);
      expect(guards).toEqual([JwtAuthGuard, ProjectAccessGuard]);
    },
  );
});

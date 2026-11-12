import 'reflect-metadata';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { InAppMessagesController } from './in-app-messages.controller';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { ProjectAccessGuard } from '../project-access/project-access.guard';
import { PROJECT_PERMISSION_KEY } from '../project-access/require-project-permission.decorator';

/** handler, permission, permission source */
const HANDLERS: Array<[string, string, object]> = [
    ['create', 'messaging.write', { param: 'projectId' }],
    ['findAll', 'project.read', { param: 'projectId' }],
    ['findOne', 'project.read', { param: 'projectId' }],
    ['update', 'messaging.write', { param: 'projectId' }],
    ['remove', 'messaging.write', { param: 'projectId' }],
    ['activate', 'messaging.write', { param: 'projectId' }],
    ['pause', 'messaging.write', { param: 'projectId' }],
    ['duplicate', 'messaging.write', { param: 'projectId' }],
];

describe('InAppMessagesController route permissions', () => {
  it.each(HANDLERS)('%s requires %s from %j', (handler, permission, from) => {
    const meta = Reflect.getMetadata(PROJECT_PERMISSION_KEY, (InAppMessagesController.prototype as unknown as Record<string, object>)[handler]);
    expect(meta).toEqual({ permission, from });
  });

  it('is JwtAuthGuard-first at class level', () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, InAppMessagesController)).toEqual([JwtAuthGuard]);
  });

  it.each(HANDLERS.map(([handler]) => handler))('%s adds ProjectAccessGuard', (handler) => {
    expect(Reflect.getMetadata(GUARDS_METADATA, (InAppMessagesController.prototype as unknown as Record<string, object>)[handler])).toEqual([ProjectAccessGuard]);
  });
});

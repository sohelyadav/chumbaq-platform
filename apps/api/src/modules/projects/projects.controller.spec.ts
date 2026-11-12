import 'reflect-metadata';
import { PROJECT_PERMISSION_KEY } from '../project-access/require-project-permission.decorator';
import { ProjectsController } from './projects.controller';

const PROJECT = { param: 'projectId' };
const ID = { param: 'id' };

// handler -> [permission, project source]. The guard reads exactly this metadata.
const TABLE: Array<[keyof ProjectsController, string, unknown]> = [
  ['findOne', 'project.read', ID],
  ['update', 'project.admin', ID],
  ['remove', 'project.admin', ID],
];

describe('ProjectsController route permissions', () => {
  it.each(TABLE)('%s needs %s', (handler, permission, from) => {
    const metadata = Reflect.getMetadata(
      PROJECT_PERMISSION_KEY,
      (ProjectsController.prototype as unknown as Record<string, object>)[handler as string],
    );
    expect(metadata).toEqual({ permission, from });
  });

  it('lists every handler', () => {
    const handlers = Object.getOwnPropertyNames(ProjectsController.prototype).filter((n) => n !== 'constructor');
    expect(handlers.filter((n) => !Reflect.hasMetadata(PROJECT_PERMISSION_KEY, (ProjectsController.prototype as any)[n])).sort())
      .toEqual(['create', 'findAll']);
    expect(TABLE.map(([h]) => h as string).sort()).toEqual(
      handlers.filter((n) => Reflect.hasMetadata(PROJECT_PERMISSION_KEY, (ProjectsController.prototype as any)[n])).sort(),
    );
  });

  it('GET :id gives the project with the caller\'s role, billing and permissions', async () => {
    const controller = new ProjectsController({} as never);
    const project = { id: 'p-1', ownerId: 'someone-else' };
    const result = await controller.findOne({ project, role: 'admin', isBillingOwner: false } as never);
    expect(result).toMatchObject({
      id: 'p-1',
      role: 'admin',
      isBillingOwner: false,
      permissions: ['project.read', 'messaging.write', 'people.read', 'channels.manage', 'keys.manage', 'members.manage', 'activity.view'],
    });
  });
});

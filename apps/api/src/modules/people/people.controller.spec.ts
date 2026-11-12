import 'reflect-metadata';
import { PROJECT_PERMISSION_KEY } from '../project-access/require-project-permission.decorator';
import { PeopleController } from './people.controller';

const PROJECT = { param: 'projectId' };

// handler -> [permission, project source]. The guard reads exactly this metadata.
const TABLE: Array<[keyof PeopleController, string, unknown]> = [
  ['listPeople', 'project.read', PROJECT],
  ['getPeopleStats', 'project.read', PROJECT],
  ['getPersonDetail', 'people.read', PROJECT],
  ['getPersonEvents', 'people.read', PROJECT],
  ['updatePersonTraits', 'messaging.write', PROJECT],
];

describe('PeopleController route permissions', () => {
  it.each(TABLE)('%s needs %s', (handler, permission, from) => {
    const metadata = Reflect.getMetadata(
      PROJECT_PERMISSION_KEY,
      (PeopleController.prototype as unknown as Record<string, object>)[handler as string],
    );
    expect(metadata).toEqual({ permission, from });
  });

  it('lists every handler', () => {
    const handlers = Object.getOwnPropertyNames(PeopleController.prototype).filter((n) => n !== 'constructor');
    expect(handlers.filter((n) => !Reflect.hasMetadata(PROJECT_PERMISSION_KEY, (PeopleController.prototype as any)[n])).sort())
      .toEqual([]);
    expect(TABLE.map(([h]) => h as string).sort()).toEqual(
      handlers.filter((n) => Reflect.hasMetadata(PROJECT_PERMISSION_KEY, (PeopleController.prototype as any)[n])).sort(),
    );
  });
});

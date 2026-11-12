import 'reflect-metadata';
import { PROJECT_PERMISSION_KEY } from '../project-access/require-project-permission.decorator';
import { EventsController } from './events.controller';

const PROJECT = { param: 'projectId' };

// handler -> [permission, project source]. The guard reads exactly this metadata.
const TABLE: Array<[keyof EventsController, string, unknown]> = [
  ['queryByProject', 'project.read', PROJECT],
  ['getEventNames', 'project.read', PROJECT],
  ['getEventVolume', 'project.read', PROJECT],
  ['getEventBreakdown', 'project.read', PROJECT],
];

describe('EventsController route permissions', () => {
  it.each(TABLE)('%s needs %s', (handler, permission, from) => {
    const metadata = Reflect.getMetadata(
      PROJECT_PERMISSION_KEY,
      (EventsController.prototype as unknown as Record<string, object>)[handler as string],
    );
    expect(metadata).toEqual({ permission, from });
  });

  it('lists every handler', () => {
    const handlers = Object.getOwnPropertyNames(EventsController.prototype).filter((n) => n !== 'constructor');
    expect(handlers.filter((n) => !Reflect.hasMetadata(PROJECT_PERMISSION_KEY, (EventsController.prototype as any)[n])).sort())
      .toEqual(['track']);
    expect(TABLE.map(([h]) => h as string).sort()).toEqual(
      handlers.filter((n) => Reflect.hasMetadata(PROJECT_PERMISSION_KEY, (EventsController.prototype as any)[n])).sort(),
    );
  });
});

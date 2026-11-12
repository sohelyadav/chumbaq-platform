import 'reflect-metadata';
import { PROJECT_PERMISSION_KEY } from '../project-access/require-project-permission.decorator';
import { TouchpointsController } from './touchpoints.controller';

const PROJECT = { param: 'projectId' };

// handler -> [permission, project source]. The guard reads exactly this metadata.
const TABLE: Array<[keyof TouchpointsController, string, unknown]> = [
  ['getJourney', 'people.read', PROJECT],
  ['getChannelSummary', 'project.read', PROJECT],
];

describe('TouchpointsController route permissions', () => {
  it.each(TABLE)('%s needs %s', (handler, permission, from) => {
    const metadata = Reflect.getMetadata(
      PROJECT_PERMISSION_KEY,
      (TouchpointsController.prototype as unknown as Record<string, object>)[handler as string],
    );
    expect(metadata).toEqual({ permission, from });
  });

  it('lists every handler', () => {
    const handlers = Object.getOwnPropertyNames(TouchpointsController.prototype).filter((n) => n !== 'constructor');
    expect(handlers.filter((n) => !Reflect.hasMetadata(PROJECT_PERMISSION_KEY, (TouchpointsController.prototype as any)[n])).sort())
      .toEqual([]);
    expect(TABLE.map(([h]) => h as string).sort()).toEqual(
      handlers.filter((n) => Reflect.hasMetadata(PROJECT_PERMISSION_KEY, (TouchpointsController.prototype as any)[n])).sort(),
    );
  });
});

import 'reflect-metadata';
import { PROJECT_PERMISSION_KEY } from '../project-access/require-project-permission.decorator';
import { LinksController } from './links.controller';

const PROJECT = { param: 'projectId' };
const LINK = { resource: 'link', param: 'id' };

// handler -> [permission, project source]. The guard reads exactly this metadata.
const TABLE: Array<[keyof LinksController, string, unknown]> = [
  ['create', 'messaging.write', PROJECT],
  ['findAllByProject', 'project.read', PROJECT],
  ['bulkCreate', 'messaging.write', PROJECT],
  ['findOne', 'project.read', LINK],
  ['getQrCode', 'project.read', LINK],
  ['update', 'messaging.write', LINK],
  ['remove', 'messaging.write', LINK],
  ['createVariant', 'messaging.write', LINK],
  ['getVariants', 'project.read', LINK],
  ['updateVariant', 'messaging.write', LINK],
  ['removeVariant', 'messaging.write', LINK],
];

describe('LinksController route permissions', () => {
  it.each(TABLE)('%s needs %s', (handler, permission, from) => {
    const metadata = Reflect.getMetadata(
      PROJECT_PERMISSION_KEY,
      (LinksController.prototype as unknown as Record<string, object>)[handler as string],
    );
    expect(metadata).toEqual({ permission, from });
  });

  it('lists every handler', () => {
    const handlers = Object.getOwnPropertyNames(LinksController.prototype).filter((n) => n !== 'constructor');
    expect(handlers.filter((n) => !Reflect.hasMetadata(PROJECT_PERMISSION_KEY, (LinksController.prototype as any)[n])).sort())
      .toEqual([]);
    expect(TABLE.map(([h]) => h as string).sort()).toEqual(
      handlers.filter((n) => Reflect.hasMetadata(PROJECT_PERMISSION_KEY, (LinksController.prototype as any)[n])).sort(),
    );
  });
});

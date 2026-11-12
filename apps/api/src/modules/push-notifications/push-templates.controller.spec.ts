import 'reflect-metadata';
import { PROJECT_PERMISSION_KEY } from '../project-access/require-project-permission.decorator';
import { PushTemplatesController } from './push-templates.controller';

const handlersOf = (controller: { prototype: object }) =>
  Object.getOwnPropertyNames(controller.prototype).filter((name) => name !== 'constructor').sort();

const declared = (controller: { prototype: object }, handler: string) =>
  Reflect.getMetadata(
    PROJECT_PERMISSION_KEY,
    (controller.prototype as Record<string, unknown>)[handler] as object,
  );

describe('PushTemplatesController route permissions', () => {
  const param = { param: 'projectId' };
  const table: Array<[string, string, object]> = [
    ['list', 'project.read', param],
    ['create', 'messaging.write', param],
    ['findOne', 'project.read', param],
    ['update', 'messaging.write', param],
    ['remove', 'messaging.write', param],
  ];

  it.each(table)('%s needs %s', (handler, permission, from) => {
    expect(declared(PushTemplatesController, handler)).toEqual({ permission, from });
  });

  it('has a row for every handler', () => {
    expect(handlersOf(PushTemplatesController)).toEqual(table.map(([h]) => h).sort());
  });
});

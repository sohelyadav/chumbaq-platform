import 'reflect-metadata';
import { PROJECT_PERMISSION_KEY } from '../project-access/require-project-permission.decorator';
import { EmailLinksController } from './email-links.controller';

const PROJECT = { param: 'projectId' };

// handler -> [permission, project source]. The guard reads exactly this metadata.
const TABLE: Array<[keyof EmailLinksController, string, unknown]> = [
  ['rewriteLinks', 'messaging.write', PROJECT],
];

describe('EmailLinksController route permissions', () => {
  it.each(TABLE)('%s needs %s', (handler, permission, from) => {
    const metadata = Reflect.getMetadata(
      PROJECT_PERMISSION_KEY,
      (EmailLinksController.prototype as unknown as Record<string, object>)[handler as string],
    );
    expect(metadata).toEqual({ permission, from });
  });

  it('lists every handler', () => {
    const handlers = Object.getOwnPropertyNames(EmailLinksController.prototype).filter((n) => n !== 'constructor');
    expect(handlers.filter((n) => !Reflect.hasMetadata(PROJECT_PERMISSION_KEY, (EmailLinksController.prototype as any)[n])).sort())
      .toEqual([]);
    expect(TABLE.map(([h]) => h as string).sort()).toEqual(
      handlers.filter((n) => Reflect.hasMetadata(PROJECT_PERMISSION_KEY, (EmailLinksController.prototype as any)[n])).sort(),
    );
  });
});

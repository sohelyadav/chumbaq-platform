import 'reflect-metadata';
import { PROJECT_PERMISSION_KEY } from '../project-access/require-project-permission.decorator';
import { AttributionController } from './attribution.controller';

const PROJECT = { param: 'projectId' };

// handler -> [permission, project source]. The guard reads exactly this metadata.
const TABLE: Array<[keyof AttributionController, string, unknown]> = [
  ['getChannelAttribution', 'project.read', PROJECT],
  ['getCampaignAttribution', 'project.read', PROJECT],
  ['getModelComparison', 'project.read', PROJECT],
  ['getConversionAttribution', 'project.read', PROJECT],
];

describe('AttributionController route permissions', () => {
  it.each(TABLE)('%s needs %s', (handler, permission, from) => {
    const metadata = Reflect.getMetadata(
      PROJECT_PERMISSION_KEY,
      (AttributionController.prototype as unknown as Record<string, object>)[handler as string],
    );
    expect(metadata).toEqual({ permission, from });
  });

  it('lists every handler', () => {
    const handlers = Object.getOwnPropertyNames(AttributionController.prototype).filter((n) => n !== 'constructor');
    expect(handlers.filter((n) => !Reflect.hasMetadata(PROJECT_PERMISSION_KEY, (AttributionController.prototype as any)[n])).sort())
      .toEqual([]);
    expect(TABLE.map(([h]) => h as string).sort()).toEqual(
      handlers.filter((n) => Reflect.hasMetadata(PROJECT_PERMISSION_KEY, (AttributionController.prototype as any)[n])).sort(),
    );
  });
});

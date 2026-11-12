import { PATH_METADATA } from '@nestjs/common/constants';
import { AttributionController } from './attribution.controller';

// The conversion id alone once returned another tenant's attribution to any
// signed-in account. Access is the route's permission guard (see the permissions
// spec); the handler must still bind the read to the project in the path.
describe('AttributionController conversion attribution', () => {
  const attributionService = { getConversionAttribution: jest.fn() };
  const controller = new AttributionController(attributionService as never);

  beforeEach(() => jest.clearAllMocks());

  it('reads only within the project in the path', async () => {
    attributionService.getConversionAttribution.mockResolvedValueOnce([]);
    await controller.getConversionAttribution('proj-1', 'conv-1');
    expect(attributionService.getConversionAttribution).toHaveBeenCalledWith('proj-1', 'conv-1');
  });

  it('lives under a project path', () => {
    expect(Reflect.getMetadata(PATH_METADATA, AttributionController.prototype.getConversionAttribution)).toBe(
      'projects/:projectId/conversions/:conversionId/attribution',
    );
  });
});

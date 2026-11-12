import { ValidationPipe, ArgumentMetadata, BadRequestException } from '@nestjs/common';
import { VALIDATION_PIPE_OPTIONS } from '../../../common/validation-pipe.options';
import { UpdateWebhookDto } from './update-webhook.dto';

/**
 * The PATCH body used to be typed `Partial<CreateWebhookDto>`, which the pipe
 * cannot see a class behind, so it validated nothing and the service assigned
 * every key it was given. A caller could move their webhook into another
 * tenant's project and be sent that tenant's events.
 */
const pipe = new ValidationPipe(VALIDATION_PIPE_OPTIONS);
const meta: ArgumentMetadata = { type: 'body', metatype: UpdateWebhookDto, data: '' };

describe('UpdateWebhookDto through the global pipe', () => {
  it.each([
    ['projectId', 'e8600afc-f4a8-4b79-ade2-64491611c32d'],
    ['secret', 'chosen-by-the-caller'],
    ['secretSealed', 'v1.a.b.c'],
  ])('refuses %s', async (field, value) => {
    await expect(pipe.transform({ isActive: false, [field]: value }, meta)).rejects.toThrow(
      BadRequestException,
    );
  });

  it('accepts what the dashboard sends', async () => {
    await expect(pipe.transform({ isActive: false }, meta)).resolves.toEqual({ isActive: false });
    await expect(
      pipe.transform({ url: 'https://example.com/hook', events: ['click'] }, meta),
    ).resolves.toEqual({ url: 'https://example.com/hook', events: ['click'] });
  });

  it('still validates the fields it allows', async () => {
    await expect(pipe.transform({ url: 'not a url' }, meta)).rejects.toThrow(BadRequestException);
  });
});

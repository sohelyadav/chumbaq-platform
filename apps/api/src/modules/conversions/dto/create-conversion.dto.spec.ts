import { ValidationPipe, ArgumentMetadata, BadRequestException } from '@nestjs/common';
import { VALIDATION_PIPE_OPTIONS } from '../../../common/validation-pipe.options';
import { CreateConversionDto } from './create-conversion.dto';

/**
 * The 400 these pin down was never a validation message anyone read: the
 * native SDKs' event queues treat a 4xx as terminal and delete the event, so
 * the symptom was an empty mobile conversion funnel and silence.
 *
 * Built from the application's own pipe options, because what matters is what
 * the deployed endpoint does with the body — a locally-constructed pipe with
 * different options would answer a different question.
 */
const pipe = new ValidationPipe(VALIDATION_PIPE_OPTIONS);

const meta: ArgumentMetadata = {
  type: 'body',
  metatype: CreateConversionDto,
  data: '',
};

describe('CreateConversionDto through the global pipe', () => {
  it('accepts the body the iOS and Android SDKs actually send', async () => {
    // Taken from ConversionTracker.swift / ConversionTracker.kt: both put
    // projectId first and omit absent keys rather than sending null.
    const body = {
      projectId: 'e8600afc-f4a8-4b79-ade2-64491611c32d',
      eventType: 'purchase',
      shortCode: 'abc123',
      externalUserId: 'user-7',
      metadata: { amount: 12.5, currency: 'USD' },
    };

    const result = (await pipe.transform(body, meta)) as CreateConversionDto;

    expect(result.projectId).toBe('e8600afc-f4a8-4b79-ade2-64491611c32d');
    expect(result.eventType).toBe('purchase');
    expect(result.metadata).toEqual({ amount: 12.5, currency: 'USD' });
  });

  it('accepts the JS SDK body, which carries no projectId', async () => {
    const result = (await pipe.transform(
      { eventType: 'signup', linkId: '3f2a91c4-7d6e-4b1a-9c58-0e2f71a4d8b3' },
      meta,
    )) as CreateConversionDto;

    expect(result.projectId).toBeUndefined();
    expect(result.eventType).toBe('signup');
  });

  it('rejects a projectId that is not a uuid', async () => {
    await expect(
      pipe.transform({ projectId: 'not-a-uuid', eventType: 'purchase' }, meta),
    ).rejects.toThrow(BadRequestException);
  });

  it('still rejects a genuinely unknown field', async () => {
    // The point is not to stop whitelisting, only to stop whitelisting out a
    // field the clients were always sending.
    await expect(
      pipe.transform({ eventType: 'purchase', platform: 'ios' }, meta),
    ).rejects.toThrow(BadRequestException);
  });
});

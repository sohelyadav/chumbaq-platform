import { ValidationPipe, ArgumentMetadata, BadRequestException } from '@nestjs/common';
import { VALIDATION_PIPE_OPTIONS } from '../../../common/validation-pipe.options';
import { MessageActionDto } from './message-action.dto';

/**
 * `@IsEnum` over an array literal validates correctly and reports
 * `must be one of the following values: ` with nothing after the colon:
 * class-validator reads the accepted set off an enum *object*, and an array
 * gives it none. A client author hitting that 400 cannot tell from the
 * response what to send instead — the same shape of problem as the silent
 * 400s this round was spent on, found by the Android SDK audit.
 */
const pipe = new ValidationPipe(VALIDATION_PIPE_OPTIONS);

const meta: ArgumentMetadata = {
  type: 'body',
  metatype: MessageActionDto,
  data: '',
};

const base = {
  messageId: '3f2a91c4-7d6e-4b1a-9c58-0e2f71a4d8b3',
  projectId: 'e8600afc-f4a8-4b79-ade2-64491611c32d',
  deviceFingerprint: 'fp-1',
};

const messagesFor = async (body: Record<string, unknown>): Promise<string> => {
  try {
    await pipe.transform(body, meta);
  } catch (err) {
    return JSON.stringify((err as BadRequestException).getResponse());
  }
  return '';
};

describe('MessageActionDto eventType validation', () => {
  it('names every accepted value when it rejects one', async () => {
    const message = await messagesFor({ ...base, eventType: 'bogus_type' });

    for (const accepted of [
      'delivered',
      'impression',
      'click',
      'dismiss',
      'cta_click',
      'auto_dismiss',
      'expired',
    ]) {
      expect(message).toContain(accepted);
    }
  });

  it('does not report an empty list of accepted values', async () => {
    // The exact string the Android audit saw:
    //   ["eventType must be one of the following values: "]
    const message = await messagesFor({ ...base, eventType: 'bogus_type' });

    expect(message).not.toContain('following values: "');
    expect(message).not.toContain('following values: \\"');
  });

  it.each([
    'delivered',
    'impression',
    'click',
    'dismiss',
    'cta_click',
    'auto_dismiss',
    'expired',
  ])('still accepts %s', async (eventType) => {
    const result = (await pipe.transform(
      { ...base, eventType },
      meta,
    )) as MessageActionDto;

    expect(result.eventType).toBe(eventType);
  });

  it('still rejects a value outside the set', async () => {
    await expect(
      pipe.transform({ ...base, eventType: 'sent' }, meta),
    ).rejects.toThrow(BadRequestException);
  });
});

import { ValidationPipe, ArgumentMetadata } from '@nestjs/common';
import { VALIDATION_PIPE_OPTIONS } from '../../../common/validation-pipe.options';
import { CreateJourneyDto, UpdateJourneyDto } from './journey.dto';
import { JourneyStep } from '../journey-definition';

/**
 * Run through the application's own pipe options, not a hand-rolled copy.
 *
 * `enableImplicitConversion` coerces every property to its reflected
 * `design:type`, and TypeScript erases `JourneyStep[]` to `Array` — so without
 * `@Type` each step was coerced into an array. Every journey created through
 * the API was saved as `[[], [], []]`: the builder looked like it worked, and
 * the runner then had nothing to run.
 */
const pipe = new ValidationPipe(VALIDATION_PIPE_OPTIONS);
const meta = (metatype: unknown): ArgumentMetadata => ({
  type: 'body',
  metatype: metatype as ArgumentMetadata['metatype'],
  data: '',
});

const trigger = { type: 'event', eventName: 'signup' };

describe('journey DTO through the real pipe', () => {
  it('keeps every step whole', async () => {
    const steps: JourneyStep[] = [
      { type: 'wait', durationSeconds: 3600 },
      { type: 'send_push', title: 'Welcome', body: 'Glad you are here' },
      { type: 'branch', segmentId: 'seg-1', ifMember: 1, ifNot: 3 },
      { type: 'exit' },
    ];

    const result = (await pipe.transform(
      { name: 'Welcome series', trigger, steps },
      meta(CreateJourneyDto),
    )) as CreateJourneyDto;

    expect(result.steps).toEqual(steps);
  });

  it('keeps a branch\'s target indexes, including zero', async () => {
    const steps: JourneyStep[] = [
      { type: 'branch', segmentId: 'seg-1', ifMember: 0, ifNot: 1 },
      { type: 'exit' },
    ];

    const result = (await pipe.transform(
      { name: 'Loop', trigger, steps },
      meta(CreateJourneyDto),
    )) as CreateJourneyDto;

    // Zero is the index most likely to be lost to a falsy check somewhere.
    expect(result.steps[0]).toMatchObject({ ifMember: 0, ifNot: 1 });
  });

  it('keeps steps whole on the edit path too', async () => {
    const steps: JourneyStep[] = [{ type: 'wait', durationSeconds: 120 }];

    const result = (await pipe.transform(
      { steps },
      meta(UpdateJourneyDto),
    )) as UpdateJourneyDto;

    expect(result.steps).toEqual(steps);
  });

  it('keeps the trigger whole', async () => {
    const result = (await pipe.transform(
      { name: 'X', trigger, steps: [{ type: 'exit' }] },
      meta(CreateJourneyDto),
    )) as CreateJourneyDto;

    expect(result.trigger).toEqual(trigger);
  });

  it('rejects a step with no type rather than emptying it', async () => {
    // Nested validation is the other half of what @Type buys: this used to be
    // accepted and stored as an empty array.
    await expect(
      pipe.transform(
        { name: 'X', trigger, steps: [{ durationSeconds: 60 }] },
        meta(CreateJourneyDto),
      ),
    ).rejects.toThrow();
  });
});

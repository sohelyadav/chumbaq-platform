import { ValidationPipe, ArgumentMetadata } from '@nestjs/common';
import { VALIDATION_PIPE_OPTIONS } from '../../../common/validation-pipe.options';
import {
  CreatePushTemplateDto,
  UpdatePushTemplateDto,
  SendPushNotificationDto,
  SendToUserDto,
} from './push-notification.dto';

/**
 * These DTOs are exercised through the *real* global pipe, not by calling
 * `validate()` directly.
 *
 * `whitelist: true` strips any property without a validation decorator, and it
 * recurses into values that class-transformer has turned into class instances.
 * That combination once silently emptied every A/B variant — arms arrived as
 * `[[], []]` — and no unit test caught it, because the stripping happens in the
 * pipe rather than in the DTO. Anything here carrying free-form nested content
 * is therefore checked against the pipe as configured in `main.ts`.
 */
// The application's own options, not a hand-rolled copy. This spec previously
// built its own pipe and omitted `enableImplicitConversion`, so it passed for
// months while actions and carousel slides were being destroyed on every real
// request — a test exercising a pipe nothing serves traffic through.
const pipe = new ValidationPipe(VALIDATION_PIPE_OPTIONS);

const meta = (metatype: unknown): ArgumentMetadata => ({
  type: 'body',
  metatype: metatype as ArgumentMetadata['metatype'],
  data: '',
});

describe('push DTO validation through the global pipe', () => {
  describe('CreatePushTemplateDto', () => {
    const base = { name: 'Weekly promo', title: 'Hello' };

    it('keeps the contents of free-form data pairs', async () => {
      const result = (await pipe.transform(
        { ...base, data: { campaign: 'spring', tier: 'gold' } },
        meta(CreatePushTemplateDto),
      )) as CreatePushTemplateDto;

      expect(result.data).toEqual({ campaign: 'spring', tier: 'gold' });
    });

    it('keeps nested delivery options rather than emptying them', async () => {
      const deliveryOptions = {
        priority: 'high',
        ttlSeconds: 3600,
        collapseKey: 'promo',
        android: { channelId: 'promos', sound: 'ding' },
        ios: { sound: 'ping', badge: 3, threadId: 'promo-thread' },
      };

      const result = (await pipe.transform(
        { ...base, deliveryOptions },
        meta(CreatePushTemplateDto),
      )) as CreatePushTemplateDto;

      // The android/ios sub-objects are the part at risk: one level deeper
      // than the property the decorator is on.
      expect(result.deliveryOptions).toEqual(deliveryOptions);
    });

    it('keeps per-language translations two levels deep', async () => {
      const translations = {
        hi: { title: 'नमस्ते', body: 'देखिए' },
        'pt-BR': { title: 'Olá' },
      };

      const result = (await pipe.transform(
        { ...base, translations },
        meta(CreatePushTemplateDto),
      )) as CreatePushTemplateDto;

      expect(result.translations).toEqual(translations);
    });
  });

  describe('UpdatePushTemplateDto', () => {
    it('keeps nested content on the edit path too', async () => {
      const result = (await pipe.transform(
        {
          data: { k: 'v' },
          deliveryOptions: { android: { channelId: 'c' } },
          translations: { hi: { title: 'नमस्ते' } },
        },
        meta(UpdatePushTemplateDto),
      )) as UpdatePushTemplateDto;

      expect(result.data).toEqual({ k: 'v' });
      expect(result.deliveryOptions).toEqual({ android: { channelId: 'c' } });
      expect(result.translations).toEqual({ hi: { title: 'नमस्ते' } });
    });
  });

  describe('SendToUserDto', () => {
    const base = {
      projectId: '3f2504e0-4f89-11d3-9a0c-0305e82c3301',
      title: 'Hello',
    };

    it('takes the user by distinctId', async () => {
      const result = (await pipe.transform(
        { ...base, distinctId: 'user-42' },
        meta(SendToUserDto),
      )) as SendToUserDto;

      expect(result.distinctId).toBe('user-42');
    });

    it('rejects externalUserId', async () => {
      // The dashboard hook sent exactly this for months. With
      // forbidNonWhitelisted the request could only ever 400, and because
      // nothing in the UI called it, nobody found out. Pinned so the client
      // and the DTO cannot drift apart silently again.
      await expect(
        pipe.transform(
          { ...base, externalUserId: 'user-42' },
          meta(SendToUserDto),
        ),
      ).rejects.toThrow();
    });

    it('needs a user at all', async () => {
      await expect(pipe.transform(base, meta(SendToUserDto))).rejects.toThrow();
    });
  });

  describe('SendPushNotificationDto', () => {
    const base = {
      projectId: '3f2504e0-4f89-11d3-9a0c-0305e82c3301',
      title: 'Hello',
    };

    it('keeps action buttons with all their fields', async () => {
      const actions = [
        { id: 'view', title: 'View', deepLinkUrl: 'https://x.test/a' },
        { id: 'snooze', title: 'Later' },
      ];

      const result = (await pipe.transform(
        { ...base, actions },
        meta(SendPushNotificationDto),
      )) as SendPushNotificationDto;

      // An action whose id was stripped would be undetectable in a click
      // report — every button tap would look like a body tap.
      expect(result.actions).toEqual(actions);
    });

    it('keeps a recurrence rule intact', async () => {
      const recurrence = {
        frequency: 'weekly',
        interval: 2,
        atTime: '09:00',
        daysOfWeek: [1, 4],
        timezone: 'Asia/Kolkata',
        endsAt: '2026-11-03T00:00:00.000Z',
      };

      const result = (await pipe.transform(
        { ...base, recurrence },
        meta(SendPushNotificationDto),
      )) as SendPushNotificationDto;

      // daysOfWeek is the field to watch: an array nested inside an object
      // typed only as @IsObject().
      expect(result.recurrence).toEqual(recurrence);
    });

    it('keeps per-arm translations inside each variant', async () => {
      const variants = [
        {
          key: 'A',
          title: 'First',
          weight: 50,
          translations: { hi: { title: 'पहला' } },
        },
        {
          key: 'B',
          title: 'Second',
          weight: 50,
          translations: { hi: { title: 'दूसरा' } },
        },
      ];

      const result = (await pipe.transform(
        { ...base, variants },
        meta(SendPushNotificationDto),
      )) as SendPushNotificationDto;

      // This is the exact shape that regressed to `[[], []]` once.
      expect(result.variants).toEqual(variants);
    });

    it('accepts a templateId', async () => {
      const templateId = 'd94f3a52-9b1e-4f3c-8a7d-2e6b1c9f4a58';
      const result = (await pipe.transform(
        { ...base, templateId },
        meta(SendPushNotificationDto),
      )) as SendPushNotificationDto;

      expect(result.templateId).toBe(templateId);
    });

    it('rejects a templateId that is not a real uuid', async () => {
      // @IsUUID() checks the variant nibble too, not just the dash layout, so
      // a plausible-looking id can still be rejected. Worth pinning: the web
      // client sends whatever a template row gave it, and a 400 here would be
      // opaque from the dashboard.
      await expect(
        pipe.transform(
          { ...base, templateId: 'not-a-uuid' },
          meta(SendPushNotificationDto),
        ),
      ).rejects.toThrow();
    });

    it('still rejects an unknown property', async () => {
      // forbidNonWhitelisted is what makes a typo in the client a 400 rather
      // than a silently ignored field.
      await expect(
        pipe.transform({ ...base, nope: 1 }, meta(SendPushNotificationDto)),
      ).rejects.toThrow();
    });
  });
});

describe('object arrays survive implicit conversion', () => {
  const base = {
    projectId: '3f2504e0-4f89-11d3-9a0c-0305e82c3301',
    title: 'Hello',
  };

  /**
   * `enableImplicitConversion` coerces every property to its reflected
   * `design:type`, and TypeScript erases `Foo[]` to `Array` — so each element
   * of an object array is coerced into an array unless `@Type` says what the
   * elements are. Each of these arrived as `[[]]` in production.
   */
  it('keeps action buttons whole', async () => {
    const actions = [
      { id: 'view', title: 'View', deepLinkUrl: 'https://x.test/a' },
      { id: 'snooze', title: 'Later' },
    ];

    const result = (await pipe.transform(
      { ...base, actions },
      meta(SendPushNotificationDto),
    )) as SendPushNotificationDto;

    expect(result.actions).toEqual(actions);
  });

  it('keeps carousel slides whole', async () => {
    const carousel = [
      { imageUrl: 'https://x.test/1.png', caption: 'One' },
      { imageUrl: 'https://x.test/2.png', deepLinkUrl: 'app://two' },
    ];

    const result = (await pipe.transform(
      { ...base, carousel },
      meta(SendPushNotificationDto),
    )) as SendPushNotificationDto;

    expect(result.carousel).toEqual(carousel);
  });

  it('keeps a string array a string array', async () => {
    // Strings are not objects, so these were never affected — asserted so the
    // distinction is recorded rather than rediscovered.
    const ids = ['3f2504e0-4f89-11d3-9a0c-0305e82c3301'];

    const result = (await pipe.transform(
      { ...base, deviceIdentityIds: ids },
      meta(SendPushNotificationDto),
    )) as SendPushNotificationDto;

    expect(result.deviceIdentityIds).toEqual(ids);
  });

  it('rejects a malformed action rather than dropping its fields', async () => {
    // The nested validation that comes with @Type: before, a button with no id
    // was accepted and silently emptied.
    await expect(
      pipe.transform(
        { ...base, actions: [{ title: 'No id' }] },
        meta(SendPushNotificationDto),
      ),
    ).rejects.toThrow();
  });
});

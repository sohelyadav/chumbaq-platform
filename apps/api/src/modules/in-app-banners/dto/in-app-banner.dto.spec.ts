import { ValidationPipe, ArgumentMetadata, BadRequestException } from '@nestjs/common';
import { VALIDATION_PIPE_OPTIONS } from '../../../common/validation-pipe.options';
import { CreateInAppBannerDto } from './create-in-app-banner.dto';
import { UpdateInAppBannerDto } from './update-in-app-banner.dto';
import { CreateBannerCategoryDto } from './create-banner-category.dto';
import { UpdateBannerCategoryDto } from './update-banner-category.dto';

/**
 * The legacy widget surface renders into a customer's page exactly as in-app
 * messages do, so it needs the same server-side half of the defence. It was
 * missed in the first pass: `backgroundColor` was a bare
 * `@IsString() @MaxLength(20)`, the same shape a message `theme` had.
 *
 * Fixtures here are the values the dev database actually holds — 10 stored
 * categories, all six-digit hex; 26 stored banners, all https — so these
 * assert against real campaign data rather than invented data.
 */
const pipe = new ValidationPipe(VALIDATION_PIPE_OPTIONS);

const meta = (metatype: unknown): ArgumentMetadata => ({
  type: 'body',
  metatype: metatype as ArgumentMetadata['metatype'],
  data: '',
});

describe('banner category appearance validation', () => {
  const create = (over: Record<string, unknown>) =>
    pipe.transform({ name: 'Home strip', ...over }, meta(CreateBannerCategoryDto));

  it('accepts the six-digit hex every stored category uses', async () => {
    const result = (await create({
      backgroundColor: '#ffffff',
    })) as CreateBannerCategoryDto;

    expect(result.backgroundColor).toBe('#ffffff');
  });

  it('accepts a compact rgba that fits the varchar(20) column', async () => {
    const result = (await create({
      backgroundColor: 'rgba(0,0,0,0.5)',
    })) as CreateBannerCategoryDto;

    expect(result.backgroundColor).toBe('rgba(0,0,0,0.5)');
  });

  it('rejects a colour that closes the style attribute', async () => {
    await expect(
      create({ backgroundColor: '#fff" onload="x' }),
    ).rejects.toThrow(BadRequestException);
  });

  it('rejects a smuggled second declaration', async () => {
    // Deliberately inside the 20-character limit, so this fails on the
    // pattern and not on the length — a longer payload would pass this test
    // even with the pattern removed.
    await expect(
      create({ backgroundColor: 'red;width:9px' }),
    ).rejects.toThrow(BadRequestException);
  });

  it('rejects a bare colour name', async () => {
    await expect(create({ backgroundColor: 'red' })).rejects.toThrow(
      BadRequestException,
    );
  });

  it('accepts a spaced rgba, which the old varchar(20) column could not hold', async () => {
    // This asserted the opposite until `WidenBannerBackgroundColor`: at
    // varchar(20) the matching `@MaxLength` refused a perfectly valid
    // 24-character CSS colour, so the limit was safe but wrong.
    const result = (await create({
      backgroundColor: 'rgba(255, 255, 255, 0.5)',
    })) as CreateBannerCategoryDto;

    expect(result.backgroundColor).toBe('rgba(255, 255, 255, 0.5)');
  });

  it('still refuses a colour longer than the widened column', async () => {
    // 33 characters: past the ceiling even after widening, so an honest 400
    // rather than a database error.
    await expect(
      create({ backgroundColor: 'rgba(255, 255, 255, 0.123456789)' + 'x' }),
    ).rejects.toThrow(BadRequestException);
  });

  it('applies the same rules on the edit path', async () => {
    await expect(
      pipe.transform(
        { backgroundColor: 'red;background:url(//e)' },
        meta(UpdateBannerCategoryDto),
      ),
    ).rejects.toThrow(BadRequestException);
  });
});

describe('banner URL validation', () => {
  const create = (over: Record<string, unknown>) =>
    pipe.transform({ title: 'Promo', ...over }, meta(CreateInAppBannerDto));

  it('accepts the https images every stored banner uses', async () => {
    const result = (await create({
      imageUrl: 'https://picsum.photos/id/340/600/200',
    })) as CreateInAppBannerDto;

    expect(result.imageUrl).toBe('https://picsum.photos/id/340/600/200');
  });

  it('rejects a scheme-less image host, which bare @IsUrl() allowed', async () => {
    await expect(create({ imageUrl: 'example.com/promo.png' })).rejects.toThrow(
      BadRequestException,
    );
  });

  it('rejects a javascript: image', async () => {
    await expect(create({ imageUrl: 'javascript:alert(1)' })).rejects.toThrow(
      BadRequestException,
    );
  });

  it('rejects an attribute breakout in an image', async () => {
    await expect(
      create({ imageUrl: 'x" onerror="alert(1)' }),
    ).rejects.toThrow(BadRequestException);
  });

  it('applies the same image rules on the edit path', async () => {
    await expect(
      pipe.transform({ imageUrl: 'javascript:alert(1)' }, meta(UpdateInAppBannerDto)),
    ).rejects.toThrow(BadRequestException);
  });

  /**
   * `clickUrl` is deliberately NOT narrowed to http(s), and is left as the
   * bare `@IsUrl()` it has always been — which is already too narrow, not too
   * wide. Three stored banners point at `chumbaq://onboarding/stepN`, and
   * `isURL` rejects a custom scheme, so those rows cannot be re-saved through
   * this DTO at all. They were written by the seed script, which bypasses
   * validation. Narrowing further would entrench that; widening it to allow
   * app schemes is a behaviour change with its own design question (which
   * schemes, and what the web renderer does with one), so it is reported
   * rather than guessed at here.
   *
   * The web SDK does not rely on this either way: `banner.ts` passes the
   * destination through `safeNavigationUrl` and drops a scheme a page must
   * not be sent to, with a diagnostic.
   */
  it('still refuses a javascript: destination', async () => {
    await expect(
      create({ clickUrl: 'javascript:alert(document.domain)' }),
    ).rejects.toThrow(BadRequestException);
  });

  it('documents that a chumbaq:// destination is refused today', async () => {
    // Not an endorsement — a record of current behaviour, so that widening
    // this later has a test that notices.
    await expect(
      create({ clickUrl: 'chumbaq://onboarding/step1' }),
    ).rejects.toThrow(BadRequestException);
  });
});

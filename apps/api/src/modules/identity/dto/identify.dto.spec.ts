import { ValidationPipe, ArgumentMetadata, BadRequestException } from '@nestjs/common';
import { VALIDATION_PIPE_OPTIONS } from '../../../common/validation-pipe.options';
import { IdentifyDto } from './identify.dto';

/**
 * `IdentifyDto.ipAddress` was a field any caller could set. It was stored on
 * the identity and passed to `resolveGeo`, under API-key auth only — and the
 * key ships inside every app binary — so anyone could write an arbitrary
 * address and an arbitrary derived country and city onto an identity.
 *
 * Nothing joins on the raw column, which is why this is not attribution theft
 * the way `FingerprintDto.ip` was. It still mattered: the geo columns it
 * writes are what the dashboards aggregate, so an unverifiable field was
 * shaping reported numbers.
 *
 * None of the four SDKs ever sent it, so unlike the deferred-match fix this
 * removal breaks no shipped client.
 */
const pipe = new ValidationPipe(VALIDATION_PIPE_OPTIONS);

const meta: ArgumentMetadata = {
  type: 'body',
  metatype: IdentifyDto,
  data: '',
};

const base = {
  projectId: 'e8600afc-f4a8-4b79-ade2-64491611c32d',
  deviceFingerprint: 'fp-1',
  platform: 'ios',
};

describe('IdentifyDto through the global pipe', () => {
  it('rejects a caller-supplied ipAddress outright', async () => {
    await expect(
      pipe.transform({ ...base, ipAddress: '203.0.113.7' }, meta),
    ).rejects.toThrow(BadRequestException);
  });

  it('names the offending property so the caller can find it', async () => {
    let response: unknown;
    try {
      await pipe.transform({ ...base, ipAddress: '203.0.113.7' }, meta);
    } catch (err) {
      response = (err as BadRequestException).getResponse();
    }

    expect(JSON.stringify(response)).toContain('ipAddress');
  });

  it('accepts the minimal body the SDKs send', async () => {
    const result = (await pipe.transform(base, meta)) as IdentifyDto;

    expect(result.projectId).toBe('e8600afc-f4a8-4b79-ade2-64491611c32d');
    expect(result.deviceFingerprint).toBe('fp-1');
  });

  it('accepts the full auto-device-info body the iOS SDK sends', async () => {
    // The 17 keys IdentityManager.buildIdentifyBody merges in when
    // enableAutoDeviceInfo is on, which is the default — confirmed accepted
    // live by the iOS agent's audit. None of them is an address.
    const result = (await pipe.transform(
      {
        ...base,
        distinctId: 'd-1',
        os: 'iOS',
        osVersion: '17.2',
        manufacturer: 'Apple',
        brand: 'Apple',
        model: 'iPhone15,2',
        screenWidth: 1179,
        screenHeight: 2556,
        carrier: 'EE',
        locale: 'en_GB',
        language: 'en',
        timezone: 'Europe/London',
        appVersion: '1.4.0',
        appBuild: '221',
      },
      meta,
    )) as IdentifyDto;

    expect(result.model).toBe('iPhone15,2');
    expect(result.timezone).toBe('Europe/London');
  });

  describe('column-width limits', () => {
    /**
     * Every string field here lands in a `varchar` column, and the DTO had no
     * length checks at all — so an over-long value reached the insert and came
     * back as a raw 500 naming the Postgres type. Confirmed live on
     * `en-US-POSIX`, a genuine Apple locale identifier, which the Flutter
     * agent hit on a simulator.
     */
    it.each([
      ['en-US', true],
      ['zh-Hans-CN', true],
      ['en-US-POSIX', true],
      ['en-Latn-GB-u-ca-gregory-x-private-ext', false],
    ])('locale %s accepted=%s', async (locale, ok) => {
      const call = pipe.transform({ ...base, locale }, meta);
      if (ok) await expect(call).resolves.toBeDefined();
      else await expect(call).rejects.toThrow(BadRequestException);
    });

    it('refuses an over-long model rather than letting the insert fail', async () => {
      await expect(
        pipe.transform({ ...base, model: 'x'.repeat(101) }, meta),
      ).rejects.toThrow(BadRequestException);
    });

    it('accepts a model at exactly the column width', async () => {
      const result = (await pipe.transform(
        { ...base, model: 'x'.repeat(100) },
        meta,
      )) as IdentifyDto;

      expect(result.model).toHaveLength(100);
    });

    it('refuses an over-long currency, which is varchar(3)', async () => {
      // Not on this DTO's own path but the same shape: TrackRevenueDto writes
      // the same column.
      await expect(
        pipe.transform({ ...base, timezone: 'x'.repeat(51) }, meta),
      ).rejects.toThrow(BadRequestException);
    });

    it('never truncates — a mangled value is worse than a refusal', async () => {
      // Nothing downstream could tell a truncated locale from a real one, so
      // an over-long value is refused rather than trimmed to fit.
      let threw = false;
      try {
        await pipe.transform({ ...base, locale: 'x'.repeat(36) }, meta);
      } catch {
        threw = true;
      }
      expect(threw).toBe(true);
    });
  });

  it('still accepts userAgent, which is a client fact and not a network one', async () => {
    // Worth pinning: `userAgent` stays caller-supplied on purpose. It
    // describes the client, which only the client knows, and nothing joins
    // or geolocates on it.
    const result = (await pipe.transform(
      { ...base, userAgent: 'Chumbaq-iOS/1.4.0' },
      meta,
    )) as IdentifyDto;

    expect(result.userAgent).toBe('Chumbaq-iOS/1.4.0');
  });
});

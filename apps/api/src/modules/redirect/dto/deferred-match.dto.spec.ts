import { ValidationPipe, ArgumentMetadata, BadRequestException } from '@nestjs/common';
import { VALIDATION_PIPE_OPTIONS } from '../../../common/validation-pipe.options';
import { DeferredMatchDto, FingerprintDto } from './deferred-match.dto';
import type { DeferredFingerprint } from '@chumbaq/shared';

/**
 * Compile-time proof that two types describe the same set of properties.
 *
 * `implements` on the DTO already fails the build when the shared interface
 * requires something the class does not have — that is the drift that bit us,
 * and `tsc --noEmit` catches it now. It is deaf to the other direction: a
 * class may carry members its interface never heard of, so adding a field to
 * the DTO alone leaves the shared copy quietly incomplete and `implements`
 * says nothing. This closes that side, and resolves to an object type naming
 * the absent key so the failure reads as an instruction.
 */
type SameKeys<A, B> = [Exclude<keyof A, keyof B>] extends [never]
  ? [Exclude<keyof B, keyof A>] extends [never]
    ? true
    : { missingFromTheApiDto: Exclude<keyof B, keyof A> }
  : { missingFromTheSharedType: Exclude<keyof A, keyof B> };

/**
 * `packages/shared/src/types.ts` is meant to be the one definition the API and
 * its clients both consume, and for this contract it had stopped being one:
 * it still declared `fingerprint.ip` as *required* long after the API made it
 * optional, and then long after the API deleted it. Nothing caught that,
 * because the shared copy had no importer and the SDK hand-rolls a third copy
 * — `tsc --noEmit` passed clean either side of a breaking change to this very
 * DTO. These two lines are what make the next divergence a build failure.
 */
const _fingerprintKeysAgree: SameKeys<FingerprintDto, DeferredFingerprint> = true;
void _fingerprintKeysAgree;

/**
 * `fingerprint.ip` used to be a field a caller could set, and the matcher
 * joined installs to clicks on it. Holding the project API key — which ships
 * inside every app binary — was therefore enough to name any address, claim
 * the most recent unmatched store-redirect click from it, and read back that
 * link's `deepLinkParams`, leaving the real installer's click spent.
 *
 * The pipe is built from the application's own options, because a local copy
 * would not tell us what the deployed endpoint does with the field.
 */
const pipe = new ValidationPipe(VALIDATION_PIPE_OPTIONS);

const meta: ArgumentMetadata = {
  type: 'body',
  metatype: DeferredMatchDto,
  data: '',
};

describe('DeferredMatchDto through the global pipe', () => {
  it('rejects a caller-supplied fingerprint.ip outright', async () => {
    // `forbidNonWhitelisted` is what makes this a 400 rather than a quiet
    // strip. A caller asking to be matched against an address it chose is
    // asking for something this endpoint will not do, and should hear so.
    await expect(
      pipe.transform(
        { fingerprint: { os: 'iOS', ip: '203.0.113.7' } },
        meta,
      ),
    ).rejects.toThrow(BadRequestException);
  });

  it('names the offending property so the caller can find it', async () => {
    let message: unknown;
    try {
      await pipe.transform({ fingerprint: { os: 'iOS', ip: '203.0.113.7' } }, meta);
    } catch (err) {
      message = (err as BadRequestException).getResponse();
    }

    expect(JSON.stringify(message)).toContain('ip');
  });

  it('accepts the fingerprint the shipped iOS and Android SDKs actually send', async () => {
    // Neither native SDK ever sent `ip`, which is why removing the field does
    // not break the binaries already in the field.
    const body = {
      fingerprint: {
        os: 'iOS',
        osVersion: '17.2',
        model: 'iPhone15,2',
        screenWidth: 1179,
        screenHeight: 2556,
      },
    };

    const result = (await pipe.transform(body, meta)) as DeferredMatchDto;

    expect(result.fingerprint).toEqual(body.fingerprint);
  });

  it('accepts a cookieRef-only body', async () => {
    const result = (await pipe.transform({ cookieRef: 'abc123' }, meta)) as DeferredMatchDto;

    expect(result).toEqual({ cookieRef: 'abc123' });
  });

  it('still rejects an unknown top-level field', async () => {
    await expect(
      pipe.transform({ fingerprint: { os: 'iOS' }, ip: '203.0.113.7' }, meta),
    ).rejects.toThrow(BadRequestException);
  });
});

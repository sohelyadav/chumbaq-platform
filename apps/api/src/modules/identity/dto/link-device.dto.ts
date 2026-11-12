import { IsString, IsOptional, IsUUID, IsIn, IsNotEmpty, MaxLength} from 'class-validator';

/**
 * Body of `POST /api/identity/link-device`.
 *
 * A real DTO rather than the inline type this used to be declared with. The
 * `ValidationPipe` has no metatype for an inline type, so it skipped the body
 * entirely: any shape at all was accepted, `projectId` was never checked to
 * be a UUID, and — the reason this exists — a caller-supplied `ipAddress` was
 * silently ignored where `identify` rejects one. Both doors into `identify`
 * now behave the same way, and a caller asking to be geolocated at an address
 * it chose is told the endpoint will not do that rather than left to assume
 * it worked. See `IdentifyDto` for what that field bought.
 *
 * Every field below is one both the iOS and Android SDKs already send —
 * `IdentityManager.linkDevice` in each sends exactly these four and nothing
 * else — so `forbidNonWhitelisted` refuses nothing a shipped client sends.
 * `platform` in particular is required here rather than optional because
 * `device_identities.platform` is NOT NULL: omitting it used to reach the
 * insert and come back as a raw 500.
 *
 * Note what this does *not* fix, because it was never broken: project
 * scoping. `assertProjectScope` has always compared `body.projectId` against
 * the API key's project before delegating, so a mismatched id was already a
 * 403. What the inline type cost was shape validation — no type checks, no
 * non-empty checks, unknown keys accepted — not isolation.
 */
export class LinkDeviceDto {
  @IsUUID()
  projectId: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  deviceFingerprint: string;

  /**
   * `@IsIn` over the same three values as `register-token.dto.ts` and the
   * shared `PushPlatform` type, which is the better-specified of the two
   * conventions already in the codebase — and exactly the set
   * `device_identities.platform` holds. Safe here because the only shipped
   * callers are the iOS and Android SDKs, each hardcoding its own value.
   *
   * Deliberately *not* applied to `IdentifyDto.platform`, which stays
   * `@IsString()`: the web SDK forwards a caller-supplied `platform` straight
   * through to identify, so constraining that one would 400 an integrator
   * passing anything outside this set — the same class of break this round
   * was spent undoing.
   */
  @IsIn(['ios', 'android', 'web'])
  platform: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  externalUserId: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  userAgent?: string;
}

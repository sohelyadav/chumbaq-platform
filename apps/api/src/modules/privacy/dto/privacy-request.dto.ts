import { BadRequestException } from '@nestjs/common';
import { IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min, MinLength } from 'class-validator';
import type { PrivacySubject } from '@chumbaq/shared';

/** No control characters: these values are hashed and matched, never displayed. */
const NO_CONTROL_CHARACTERS = /^[^\u0000-\u001f\u007f]+$/;

/**
 * Body of the server API's `POST /api/privacy/erasures` and `/exports`.
 * Exactly one field. In the body rather than the path so the person's
 * identifier stays out of URLs and access logs.
 */
export class PrivacyRequestDto {
  /** The id your app passes to identify (`external_user_id`). */
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  @Matches(NO_CONTROL_CHARACTERS, { message: 'externalUserId must not contain control characters' })
  externalUserId?: string;

  /** An anonymous device's id, as the SDK reports it (`device_fingerprint`). */
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  @Matches(NO_CONTROL_CHARACTERS, { message: 'deviceFingerprint must not contain control characters' })
  deviceFingerprint?: string;
}

export function subjectFromRequest(dto: PrivacyRequestDto): PrivacySubject {
  const hasUser = typeof dto.externalUserId === 'string';
  const hasDevice = typeof dto.deviceFingerprint === 'string';
  if (hasUser === hasDevice) {
    throw new BadRequestException('Send exactly one of externalUserId or deviceFingerprint');
  }
  return hasUser
    ? { type: 'externalUserId', value: dto.externalUserId as string }
    : { type: 'deviceFingerprint', value: dto.deviceFingerprint as string };
}

/**
 * Body of `POST /api/projects/:projectId/privacy-requests/search`: "was this
 * user erased?". A POST so the user id stays out of URLs and access logs.
 */
export class PrivacyRequestSearchDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  @Matches(NO_CONTROL_CHARACTERS, { message: 'externalUserId must not contain control characters' })
  externalUserId?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}

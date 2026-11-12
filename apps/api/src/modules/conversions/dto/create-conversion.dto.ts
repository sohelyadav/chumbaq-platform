import {
  IsString,
  IsOptional,
  IsObject,
  IsUUID,
  IsNotEmpty, MaxLength} from 'class-validator';

export class CreateConversionDto {
  /**
   * Redundant — the API key already resolves the project — but accepted
   * because the iOS and Android SDKs send it, and `forbidNonWhitelisted` made
   * that a hard `400 ["property projectId should not exist"]`. Their event
   * queues treat a 4xx as terminal and delete the event, so no conversion
   * from a mobile SDK was ever recorded.
   *
   * Validated against the key's project rather than ignored: silently
   * accepting a project id that is not the caller's would let a body disagree
   * with the credential and never say so. Mirrors
   * `POST /api/identity/revenue`, which has always worked this way — the
   * difference being that this one is optional, since the JS SDK does not
   * send it.
   */
  @IsOptional()
  @IsUUID()
  projectId?: string;

  @IsOptional()
  @IsString()
  shortCode?: string;

  @IsOptional()
  @IsUUID()
  linkId?: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  eventType: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  externalUserId?: string;

  @IsOptional()
  @IsObject()
  metadata?: Record<string, any>;
}

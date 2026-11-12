import {
  IsOptional,
  IsString,
  ValidateNested,
  IsNumber,
} from 'class-validator';
import { Type } from 'class-transformer';
import type {
  DeferredFingerprint,
  DeferredMatchDto as SharedDeferredMatchDto,
} from '@chumbaq/shared';

/**
 * What a device may say about itself when claiming a deferred deep link.
 *
 * Deliberately no `ip`. The matcher pairs an install with a click from the
 * same address, so an IP in the body is an instruction to claim whoever's
 * click that was: the project API key ships inside every app binary, so
 * anyone holding one could name an address, take the most recent unmatched
 * store-redirect click from it, and read that link's `deepLinkParams` while
 * the real installer's attribution was marked spent. The address now comes
 * from the request and nowhere else — see `getClientIp`.
 *
 * `forbidNonWhitelisted` means a body that still carries `fingerprint.ip` is
 * a 400 rather than a silent strip, which is the honest answer: the caller is
 * asking for something the endpoint will not do.
 */
export class FingerprintDto implements DeferredFingerprint {
  @IsString()
  os: string;

  @IsOptional()
  @IsString()
  osVersion?: string;

  @IsOptional()
  @IsString()
  model?: string;

  @IsOptional()
  @IsNumber()
  screenWidth?: number;

  @IsOptional()
  @IsNumber()
  screenHeight?: number;
}

export class DeferredMatchDto implements SharedDeferredMatchDto {
  @IsOptional()
  @ValidateNested()
  @Type(() => FingerprintDto)
  fingerprint?: FingerprintDto;

  @IsOptional()
  @IsString()
  cookieRef?: string;
}

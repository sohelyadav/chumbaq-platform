import { IsString, IsOptional, IsUrl, MaxLength, ValidateBy } from 'class-validator';
import { isPlatformHost, PLATFORM_HOST_MESSAGE } from '../../../common/platform-hosts';

/** A project may not claim a host the platform serves itself; see `common/platform-hosts.ts`. */
function IsNotPlatformHost(): PropertyDecorator {
  return ValidateBy({
    name: 'isNotPlatformHost',
    validator: {
      validate: (value: unknown) => typeof value !== 'string' || !isPlatformHost(value),
      defaultMessage: () => PLATFORM_HOST_MESSAGE,
    },
  });
}

export class CreateProjectDto {
  @IsString()
  @MaxLength(255)
  name: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  @IsNotPlatformHost()
  domain?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  iosBundleId?: string;

  @IsOptional()
  @IsUrl()
  @MaxLength(512)
  iosAppStoreUrl?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  iosTeamId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  iosAppStoreId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  androidPackageName?: string;

  @IsOptional()
  @IsUrl()
  @MaxLength(512)
  androidPlayStoreUrl?: string;

  @IsOptional()
  @IsString()
  androidSha256Fingerprints?: string;

  @IsOptional()
  @IsUrl()
  @MaxLength(512)
  webFallbackUrl?: string;
}

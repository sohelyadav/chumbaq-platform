import { IsString, IsOptional, IsUrl, MaxLength } from 'class-validator';

export class CreateProjectDto {
  @IsString()
  @MaxLength(255)
  name: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
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

import { IsString, IsOptional, IsBoolean, IsInt, IsObject, IsDateString, IsUrl, MaxLength, Min } from 'class-validator';

export class UpdateInAppBannerDto {
  @IsOptional()
  @IsString()
  @MaxLength(255)
  title?: string;

  /**
   * http(s) only. Bare `@IsUrl()` accepts a scheme-less `example.com`, which
   * is not something a page can be told to load an image from.
   */
  @IsOptional()
  @IsUrl({ protocols: ['http', 'https'], require_protocol: true })
  @MaxLength(2048)
  imageUrl?: string;

  @IsOptional()
  @IsUrl()
  @MaxLength(2048)
  clickUrl?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  ctaText?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  sortOrder?: number;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @IsOptional()
  @IsDateString()
  startsAt?: string;

  @IsOptional()
  @IsDateString()
  expiresAt?: string;

  @IsOptional()
  @IsObject()
  metadata?: Record<string, any>;
}

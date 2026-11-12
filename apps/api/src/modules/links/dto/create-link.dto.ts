import {
  IsString,
  IsOptional,
  IsUrl,
  IsBoolean,
  IsObject,
  IsArray,
  IsDateString,
  Length,
  Matches,
  MaxLength,
} from 'class-validator';

export class CreateLinkDto {
  @IsUrl()
  @MaxLength(2048)
  longUrl: string;

  @IsOptional()
  @IsString()
  @Length(3, 30)
  @Matches(/^[a-zA-Z0-9_-]+$/, {
    message:
      'shortCode must contain only letters, numbers, hyphens, or underscores',
  })
  shortCode?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  title?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  tags?: string[];

  @IsOptional()
  @IsUrl()
  @MaxLength(2048)
  iosUrl?: string;

  @IsOptional()
  @IsUrl()
  @MaxLength(2048)
  androidUrl?: string;

  @IsOptional()
  @IsUrl()
  @MaxLength(2048)
  iosFallbackUrl?: string;

  @IsOptional()
  @IsUrl()
  @MaxLength(2048)
  androidFallbackUrl?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  ogTitle?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2048)
  ogDescription?: string;

  @IsOptional()
  @IsUrl()
  @MaxLength(2048)
  ogImageUrl?: string;

  @IsOptional()
  @IsObject()
  deepLinkParams?: Record<string, any>;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @IsOptional()
  @IsDateString()
  expiresAt?: string;
}

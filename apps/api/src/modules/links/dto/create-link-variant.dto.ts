import { IsString, IsOptional, IsUrl, IsInt, Min, Max, MaxLength } from 'class-validator';

export class CreateLinkVariantDto {
  @IsString()
  @MaxLength(255)
  name: string;

  @IsUrl()
  @MaxLength(2048)
  longUrl: string;

  @IsOptional()
  @IsUrl()
  @MaxLength(2048)
  iosUrl?: string;

  @IsOptional()
  @IsUrl()
  @MaxLength(2048)
  androidUrl?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100)
  weight?: number;
}
